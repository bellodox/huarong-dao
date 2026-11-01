import { parseTransaction,parseName,verifyInput,APP_NAME,payScript } from './chain.js';
import { bytesToHex,hexToBytes } from './receipt.js';
import { deriveReceipt } from './reconcile.js';
import { verifyClaim } from './verify.js';
import { recoveryReadiness } from './storage.js';

export const RECOVERY_CONFIRMATIONS=6,RECOVERY_HEADER_BOUND=2000;
/** Service-only inspection; raw export is explicit and content-address checked, never a signer. */
export async function inspectRecovery(storage,rawTxid=null) {
  const ready=await recoveryReadiness(storage);
  if(ready.code==='recovery_schema_upgrade_required')return {ok:false,code:ready.code};
  const inspected=await storage.recoveryRead(),journal=inspected?.id?inspected:null;
  let exported={};
  if(rawTxid!==null) {
    if(!/^[a-f0-9]{64}$/.test(rawTxid))throw Error('invalid_recovery_arguments');
    const row=await storage.recoveryRead('raw',{txid:rawTxid});
    if(!row?.raw||parseTransaction(row.raw).txid!==rawTxid)throw Error('recovery_raw_not_found');
    exported={raw_txid:rawTxid,raw:row.raw,receipt_id:row.claim_id,generation:row.generation,scope_id:row.scope_id};
  }
  return {ok:true,mode:'recovery_inspect',recovery_id:journal?.id??null,status:journal?.status??'not_installed',
    original_txid:journal?.envelope.original_txid??null,replacement_txid:journal?.attempt.txid??null,
    confirmations:journal?.attempt.confirmations??0,transactions:journal?.transactions??0,broadcasts:journal?.broadcasts??0,
    fee_units:journal?.fee_units??0,new_locked_units:journal?.new_locked_units??0,...exported};
}
/** Install immutable fresh authority only; positive retirement is independently checked on resume. */
export async function installRecovery(storage,config,envelope) {
  const ready=await recoveryReadiness(storage);
  if(ready.code==='recovery_schema_upgrade_required')return {ok:false,code:ready.code};
  const original=(await storage.read()).claims.find(row=>row.id===envelope.claim_id);
  if(!original)throw Error('recovery_original_mismatch');
  authenticateOriginal(original,config);
  const result=await storage.rpc('recovery_install',envelope);
  if(!result?.id)return {ok:false,code:result?.code??'recovery_unavailable'};
  return {ok:true,mode:'recovery_install',recovery_id:result.id,status:result.status,broadcasts:0};
}
/** Re-authenticate the exact original journal, never provider-decoded transaction metadata. */
export function authenticateOriginal(original,config) {
  const tx=parseTransaction(original.raw),key=hexToBytes(config.appKey);
  const names=tx.outputs.map(output=>parseName(output.script)).filter(Boolean);
  const verified=verifyClaim(original.bytes,original.id);
  if(tx.txid!==original.txid||names.length!==1||names[0].name!==APP_NAME||
    names[0].operation!==original.prepared?.operation||names[0].value!==original.receipt||
    bytesToHex(names[0].payment)!==bytesToHex(payScript(key))||
    !tx.outputs.some(output=>bytesToHex(output.script)===bytesToHex(payScript(hexToBytes(config.markerKey))))||
    deriveReceipt(original.receipt,config.appKey).id!==verified.id||verified.player!==original.player||
    verified.claim.w!==original.epoch||verified.claim.l!==original.layout||verified.claim.n!==original.nickname||
    verified.moves!==original.moves||verified.points!==original.points||original.prepared.inputs.length!==tx.inputs.length)throw Error('recovery_original_mismatch');
  tx.inputs.forEach((input,index)=>{
    const saved=original.prepared.inputs.find(row=>row.txid===input.txid&&row.index===input.index);
    const previous=parseTransaction(saved?.previousRaw,{funding:true}),output=previous.outputs[input.index];
    if(previous.txid!==input.txid||!output||saved.amount!==output.amount||saved.script!==bytesToHex(output.script))throw Error('recovery_original_mismatch');
    verifyInput(tx,index,output.script,key);
  });
  return tx;
}
/** Positive retirement proof under the existing single-provider anchored trust model.
 * Not-found, unspent status and fee rejection are deliberately not evidence of retirement.
 * Recheck the entire bounded proof-to-tip path on EVERY attempt, including exact retries. */
export async function authenticateRetirement(api,original,conflictTxid,config,document,saved=null) {
  const originalTx=authenticateOriginal(original,config);
  if(!/^[a-f0-9]{64}$/.test(conflictTxid??'')||conflictTxid===original.txid)throw Error('recovery_invalid_conflict');
  const tip=await api.tipInfo();let conflict;
  try {conflict=await api.transaction(conflictTxid);}
  catch(error){if(error.message==='not_found')throw Error(saved?'recovery_proof_reorg':'recovery_frozen');throw error;}
  if(conflict.height===null||tip.height-conflict.height+1<RECOVERY_CONFIRMATIONS)throw Error(saved?'recovery_proof_reorg':'recovery_frozen');
  if(tip.height-conflict.height+1>RECOVERY_HEADER_BOUND)throw Error('recovery_history_bound');
  const tx=parseTransaction(conflict.raw,{funding:true});
  if(tx.txid!==conflictTxid)throw Error('recovery_invalid_conflict');
  const index=tx.inputs.findIndex(input=>originalTx.inputs.some(old=>old.txid===input.txid&&old.index===input.index));
  if(index<0)throw Error('recovery_no_shared_input');
  const input=tx.inputs[index],previous=original.prepared.inputs.find(row=>row.txid===input.txid&&row.index===input.index);
  verifyInput(tx,index,parseTransaction(previous.previousRaw,{funding:true}).outputs[input.index].script,hexToBytes(config.appKey));
  const headers=await api.fetchHeaders(conflict.height,tip.height),first=headers[0],last=headers.at(-1);
  const overlap=headers.find(header=>document.headers.some(known=>known.height===header.height&&known.hash===header.hash));
  if(first.hash!==conflict.blockHash||!first.tx.includes(tx.txid)||last.hash!==tip.hash||!overlap)throw Error('recovery_proof_reorg');
  const proof={original_txid:original.txid,conflict_txid:tx.txid,raw:conflict.raw,height:conflict.height,
    block_hash:conflict.blockHash,input:{txid:input.txid,index:input.index}};
  if(saved&&(['original_txid','conflict_txid','raw','height','block_hash'].some(key=>saved[key]!==proof[key])||
    saved.input?.txid!==proof.input.txid||saved.input?.index!==proof.input.index))throw Error('recovery_proof_reorg');
  if((await api.tipInfo()).hash!==tip.hash)throw Error('history_changed');
  return {proof,tip,confirmations:tip.height-conflict.height+1};
}
