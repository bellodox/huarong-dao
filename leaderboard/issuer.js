import { secp256k1 } from '@noble/curves/secp256k1.js';
import { parseCanonical,canonical,signApp } from './receipt.js';
import { buildTransaction,signTransaction } from './chain.js';

/** Admit only a Worker-verified claim using the atomic SQL decision/reservation. */
export async function admit(storage,verified) {
  const {id,text,player,claim,moves,points}=verified;
  return storage.rpc('admit',{id,bytes:text,player,nickname:claim.n,layout:claim.l,epoch:claim.w,moves,points});
}
/** One bounded recovery/broadcast attempt, always using durably stored exact bytes. */
export async function broadcastStored(storage,chain,claim) {
  if(!claim.raw || !claim.txid)throw Error('missing_persisted_bytes');
  // An uncertain previous outcome is investigated, never replaced with another spend.
  if(claim.attempts>0) {
    const observation=await chain.lookup(claim.txid,claim.prepared.inputs);
    if(['included','mempool'].includes(observation?.state))return claim;
    if(observation?.state==='conflict_suspected')throw Error('conflict_suspected');
  }
  const owned={id:claim.id,owner:claim.owner,generation:claim.generation};
  const attempt=await storage.rpc('broadcast',owned);
  if(attempt.code)return attempt;
  if(attempt.raw!==claim.raw || attempt.txid!==claim.txid)throw Error('outbox_conflict');
  try {
    const txid=await chain.broadcast(attempt.raw);
    if(txid!==attempt.txid)throw Error('broadcast_unknown');
    // Acknowledgement is NOT inclusion or confirmation. Keep it pending/unknown.
    return {...attempt,state:'broadcast_pending'};
  }catch {return {...attempt,state:'broadcast_unknown'};}
}
/** Fenced signing: never sign on an uncertain begin response and never fetch before finalize. */
export async function advance(storage,chain,secret,markerKey,id) {
  let state=await storage.read(), claim=state.claims.find(row=>row.id===id);
  if(!claim)return {code:'not_found'};
  // Included (1-5 confirmations) is reconciled from chain history, never rebroadcast or re-signed.
  if(['confirmed','included','reorged','conflicted','failed_closed'].includes(claim.state))return claim;
  if(claim.raw)return broadcastStored(storage,chain,claim);
  if(!['queued','unsigned_preparing'].includes(claim.state))return claim;
  const observation=structuredClone(await chain.prepare(claim));
  const owner=crypto.randomUUID(), coordinator=state.coordinator;
  if(observation.epoch!==claim.epoch || observation.head!==coordinator.head)return {code:'epoch_changed'};
  if(observation.head===null ? observation.prepared.operation!=='register' :
    observation.prepared.operation!=='update'||!observation.prepared.inputs.some(input=>input.txid+':'+input.index===observation.head))return {code:'reconciliation_required'};
  // Validate serialization/funds before entering the irreversible signing barrier.
  buildTransaction(observation.prepared,{...parseCanonical(claim.bytes,7),a:'A'.repeat(87)},secp256k1.getPublicKey(secret),markerKey);
  const lease=await storage.rpc('prepare',{id,owner,revision:coordinator.revision,epoch:observation.epoch,head:observation.head,prepared:observation.prepared});
  if(lease.code)return lease;
  const owned={id,owner,generation:lease.generation};
  const fresh=await chain.validate(structuredClone(observation));
  if(!fresh)return {code:'reconciliation_required'};
  const barrier=await storage.rpc('begin',{...owned,revision:lease.evaluation_revision,epoch:observation.epoch,head:observation.head,prepared:observation.prepared});
  if(barrier.state!=='signing_started')return barrier;
  // No retries wrap signing. Once entered, a lost execution fails closed indefinitely.
  const receipt=signApp(parseCanonical(claim.bytes,7),secret);
  const tx=buildTransaction(observation.prepared,receipt,secp256k1.getPublicKey(secret),markerKey);
  const signed=signTransaction(tx,secret);
  const persisted=await storage.rpc('finalize',{...owned,raw:signed.raw,txid:signed.txid,receipt:canonical(receipt,8)});
  if(persisted.raw!==signed.raw || persisted.txid!==signed.txid)throw Error('persistence_unconfirmed');
  return broadcastStored(storage,chain,persisted);
}
