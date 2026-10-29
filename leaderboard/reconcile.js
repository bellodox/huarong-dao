import { parseTransaction,parseName,payScript,verifyInput,APP_NAME } from './chain.js';
import { parseCanonical,canonical,recover,receiptId,hexToBytes,bytesToHex } from './receipt.js';
import { replay,epoch,medianTime } from './profile.js';

/** Exhaust all snapshot-bound address pages; fail closed on gaps or unstable discovery. */
export async function discoverHistory(fetchPage,{maxPages=10000}={}) {
  const ids=new Set();let offset=0,total=null,snapshot=null;
  for(let page=0;page<maxPages;page++) {
    const result=await fetchPage(offset);
    if(!Number.isSafeInteger(result.txcount)||result.txcount<0||!Array.isArray(result.tx)||!result.snapshot)throw Error('history_incomplete');
    if(total===null){total=result.txcount;snapshot=result.snapshot;}
    if(total!==result.txcount||snapshot!==result.snapshot)throw Error('history_changed');
    if(result.tx.some(txid=>!/^[a-f0-9]{64}$/.test(txid)))throw Error('invalid_history');
    for(const txid of result.tx)ids.add(txid);
    offset+=result.tx.length;
    if(offset>=total) {if(ids.size!==total)throw Error('history_incomplete');return [...ids];}
    if(!result.tx.length)throw Error('history_incomplete');
  }
  throw Error('history_budget_exceeded');
}
/** Rebuild solely from canonical-chain raw transactions and a separately pinned bootstrap.
 * The caller MUST supply consensus-verified canonical observations (fixtures locally).
 * A mutable name response or an API's self-asserted completeness is not such a source.
 */
export function reconstruct({complete,headers,transactions,previousTransactions=[],bootstrap}) {
  if(complete!==true || !headers?.length || headers[0].height!==0)throw Error('canonical_history_required');
  headers.forEach((header,index)=>{
    if(header.height!==index||!Number.isSafeInteger(header.time)||header.time<0||
       (index>0&&header.previous!==headers[index-1].hash)||!/^([a-f0-9]{64})$/.test(header.hash))throw Error('invalid_headers');
  });
  const key=hexToBytes(bootstrap.appKey),marker=payScript(hexToBytes(bootstrap.markerKey));
  const ownerScript=bytesToHex(payScript(key));
  const previous=new Map(previousTransactions.map(raw=>{const tx=parseTransaction(raw);return [tx.txid,tx];}));
  const ordered=transactions.map(observation=>({...observation,tx:parseTransaction(observation.raw)}))
    .sort((a,b)=>a.height-b.height||a.index-b.index);
  const txids=new Set(),positions=new Set(),names=new Map(),receipts=[],pending=[],invalid=[];
  let head=null,foundBootstrap=false;
  for(const observation of ordered) {
    const {tx,height,index,blockHash}=observation;
    if(txids.has(tx.txid))continue;
    if(!headers[height]||headers[height].hash!==blockHash||!Number.isSafeInteger(index)||index<0||positions.has(height+':'+index))throw Error('invalid_inclusion');
    positions.add(height+':'+index);txids.add(tx.txid);
    const spendsHead=head && tx.inputs.some(input=>input.txid+':'+input.index===head);
    const isBootstrap=tx.txid===bootstrap.txid;
    if(!isBootstrap && !spendsHead){previous.set(tx.txid,tx);continue;}
    const named=tx.outputs.map((output,index)=>({output,index,name:parseName(output.script)})).filter(item=>item.name);
    if(named.length!==1 || named[0].name.name!==APP_NAME || bytesToHex(named[0].name.payment)!==ownerScript ||
       (isBootstrap?named[0].name.operation!=='register':named[0].name.operation!=='update'))throw Error('name_lineage_conflict');
    if(isBootstrap && foundBootstrap)throw Error('duplicate_bootstrap');
    if(!tx.outputs.some(output=>bytesToHex(output.script)===bytesToHex(marker)))throw Error('missing_marker');
    let inputTotal=0;
    tx.inputs.forEach((input,index)=>{
      const previousOutput=previous.get(input.txid)?.outputs[input.index];if(!previousOutput)throw Error('missing_previous_raw');
      verifyInput(tx,index,previousOutput.script,key);inputTotal+=previousOutput.amount;
    });
    if(tx.outputs.reduce((sum,output)=>sum+output.amount,0)>inputTotal)throw Error('invalid_funds');
    foundBootstrap ||= isBootstrap;head=tx.txid+':'+named[0].index;previous.set(tx.txid,tx);
    try {
      const final=parseCanonical(named[0].name.value,8),{a,...claim}=final,{s,...unsigned}=claim;
      if(recover('app',canonical(claim,7),a)!==bootstrap.appKey)throw Error('unauthorized_app');
      const player=recover('player',canonical(unsigned,6),s),derived=replay(final);
      if(names.has(player)&&names.get(player)!==final.n)throw Error('name_conflict');
      names.set(player,final.n);
      const actualEpoch=epoch(medianTime(headers.slice(Math.max(0,height-10),height+1).map(header=>header.time)));
      const row={id:receiptId(claim),txid:tx.txid,player,nickname:final.n,layout:final.l,epoch:actualEpoch,
        moves:derived.moves,points:derived.points,height,transaction_index:index,output_index:named[0].index,receipt:named[0].name.value};
      if(headers.length-height>=6)receipts.push(row);else pending.push({...row,confirmations:headers.length-height});
    }catch(error){invalid.push({txid:tx.txid,code:error.message});}
  }
  if(!foundBootstrap)throw Error('bootstrap_missing');
  const currentEpoch=epoch(medianTime(headers.slice(-11).map(header=>header.time)));
  const closing=new Map();
  headers.forEach((header,height)=>{const week=epoch(medianTime(headers.slice(Math.max(0,height-10),height+1).map(h=>h.time)));if(!closing.has(week))closing.set(week,height);});
  return {receipts,pending,invalid,head,epoch:currentEpoch,height:headers.at(-1).height,hash:headers.at(-1).hash,
    finalizedEpochs:[...closing].filter(([week,height])=>week>0&&headers.length-height>=12).map(([week])=>week-1)};
}
/** Halt first, then verify outside SQL; only a revision-bound atomic rebuild may resume. */
export async function reconcile(storage,source) {
  const halted=await storage.rpc('halt');
  const observed=await source.history();
  const result=reconstruct(observed);
  return storage.rpc('rebuild',{revision:halted.revision,epoch:result.epoch,head:result.head,snapshot:{...result,stale:false}});
}
