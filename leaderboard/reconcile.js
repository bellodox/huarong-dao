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
// MTP needs eleven headers; an anchored chain must start this far before any lineage block.
const MTP_WINDOW=11;
/** Authenticate one canonical name value as app-issued and player-signed, then replay it.
 * Shared by full reconstruction and the incremental durable follower (identical semantics). */
export function deriveReceipt(value,appKey) {
  const final=parseCanonical(value,8),{a,...claim}=final,{s,...unsigned}=claim;
  if(recover('app',canonical(claim,7),a)!==appKey)throw Error('unauthorized_app');
  const player=recover('player',canonical(unsigned,6),s),derived=replay(final);
  return {id:receiptId(claim),player,nickname:final.n,layout:final.l,moves:derived.moves,points:derived.points};
}
export function reconstruct({complete,headers,transactions,previousTransactions=[],bootstrap,anchor=null,checkpoint=null}) {
  // Optional pinned checkpoint replaces genesis as the first header (bounded incremental sync).
  // It is caller-pinned configuration, never derived from the observations themselves.
  const base=anchor?anchor.height:0;
  if(anchor&&(!Number.isSafeInteger(base)||base<0||headers?.[0]?.hash!==anchor.hash))throw Error('canonical_history_required');
  if(complete!==true || !headers?.length || headers[0].height!==base)throw Error('canonical_history_required');
  headers.forEach((header,index)=>{
    if(header.height!==base+index||!Number.isSafeInteger(header.time)||header.time<0||
       (index>0&&header.previous!==headers[index-1].hash)||!/^([a-f0-9]{64})$/.test(header.hash))throw Error('invalid_headers');
  });
  const at=height=>height>=base?headers[height-base]:undefined, tip=base+headers.length-1;
  const key=hexToBytes(bootstrap.appKey),marker=payScript(hexToBytes(bootstrap.markerKey));
  const ownerScript=bytesToHex(payScript(key));
  // Unrelated/previous raws may be ordinary v1 wallet transactions; lineage stays strict below.
  const previous=new Map(previousTransactions.map(raw=>{const tx=parseTransaction(raw,{funding:true});return [tx.txid,tx];}));
  const ordered=transactions.map(observation=>({...observation,tx:parseTransaction(observation.raw,{funding:true})}))
    .sort((a,b)=>a.height-b.height||a.index-b.index);
  // A checkpoint is separately trusted operational state, never provider-supplied authority.
  // Keep ten predecessors for MTP and recheck the checkpoint header before extending it.
  if(checkpoint&&(!at(checkpoint.height)||at(checkpoint.height).hash!==checkpoint.hash||checkpoint.bootstrap!==bootstrap.txid))throw Error('checkpoint_mismatch');
  const txids=new Set(),positions=new Set(),names=new Map(),receipts=[],pending=[],invalid=[...(checkpoint?.invalid??[])],lineage=[];
  for(const row of [...(checkpoint?.receipts??[]),...(checkpoint?.pending??[])]) {
    names.set(row.player,row.nickname);
    const {confirmations:ignored,...receipt}=row,confirmations=tip-row.height+1;
    if(confirmations>=6)receipts.push(receipt);else pending.push({...receipt,confirmations});
  }
  for(const row of checkpoint?.lineage??[])lineage.push({...row,confirmations:tip-row.height+1});
  let head=checkpoint?.head??null,foundBootstrap=!!checkpoint?.head;
  for(const observation of ordered) {
    const {tx,height,index,blockHash}=observation;
    if(checkpoint&&height<=checkpoint.height)throw Error('checkpoint_overlap');
    if(txids.has(tx.txid))continue;
    if(!at(height)||at(height).hash!==blockHash||!Number.isSafeInteger(index)||index<0||positions.has(height+':'+index))throw Error('invalid_inclusion');
    positions.add(height+':'+index);txids.add(tx.txid);
    const spendsHead=head && tx.inputs.some(input=>input.txid+':'+input.index===head);
    const isBootstrap=tx.txid===bootstrap.txid;
    if(!isBootstrap && !spendsHead){previous.set(tx.txid,tx);continue;}
    // Lineage transactions are app-generated: enforce the strict v2/final/canonical policy.
    parseTransaction(observation.raw);
    if(height-base<MTP_WINDOW-1&&base>0)throw Error('anchor_too_recent');
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
    const predecessor=head;
    foundBootstrap ||= isBootstrap;head=tx.txid+':'+named[0].index;previous.set(tx.txid,tx);
    // Canonical name operations are distinct from finalized score receipts (even invalid scores
    // advance the authenticated name head). Retain exact evidence for no-journal reorg barriers.
    const confirmations=tip-height+1,position=height-base;
    lineage.push({txid:tx.txid,raw:observation.raw,head,predecessor,height,confirmations});
    try {
      const derived=deriveReceipt(named[0].name.value,bootstrap.appKey),player=derived.player;
      if(names.has(player)&&names.get(player)!==derived.nickname)throw Error('name_conflict');
      names.set(player,derived.nickname);
      const actualEpoch=epoch(medianTime(headers.slice(Math.max(0,position-10),position+1).map(header=>header.time)));
      const row={...derived,txid:tx.txid,epoch:actualEpoch,
        height,transaction_index:index,output_index:named[0].index,receipt:named[0].name.value};
      if(confirmations>=6)receipts.push(row);else pending.push({...row,confirmations});
    }catch(error){invalid.push({txid:tx.txid,code:error.message});}
  }
  if(!foundBootstrap)throw Error('bootstrap_missing');
  const currentEpoch=epoch(medianTime(headers.slice(-11).map(header=>header.time)));
  const closing=new Map((checkpoint?.epochTransitions??[]).map(row=>[row.week,row.height]));
  // Anchored chains lack predecessors for the first MTP window; skip those partial medians.
  // The first full-window week of an anchored chain is not an observed transition, so skip it.
  let anchoredFirst=null;
  headers.forEach((header,position)=>{if(base>0&&position<MTP_WINDOW-1)return;
    const week=epoch(medianTime(headers.slice(Math.max(0,position-10),position+1).map(h=>h.time)));
    if(base>0&&(anchoredFirst??=week)===week)return;
    if(!closing.has(week))closing.set(week,header.height);});
  return {receipts,pending,invalid,lineage,head,epoch:currentEpoch,height:headers.at(-1).height,hash:headers.at(-1).hash,
    epochTransitions:[...closing].map(([week,height])=>({week,height})),
    finalizedEpochs:[...new Set([...(checkpoint?.finalizedEpochs??[]),...[...closing].filter(([week,height])=>week>0&&tip-height+1>=12).map(([week])=>week-1)])]};
}
/** Halt first, then verify outside SQL; only a revision-bound atomic rebuild may resume. */
export async function reconcile(storage,source) {
  const halted=await storage.rpc('halt');
  const observed=await source.history();
  const result=reconstruct(observed);
  return storage.rpc('rebuild',{revision:halted.revision,epoch:result.epoch,head:result.head,snapshot:{...result,stale:false}});
}
