import { NETWORK } from './chain.js';

export const PUBLIC_RESPONSE_BYTES=262144;
/** Small server-only persistence boundary. No SQL transaction spans these HTTP calls. */
export class SupabaseStorage {
  constructor(url,serviceKey,transport=fetch) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash)throw Error('invalid_storage_configuration');
    this.endpoint=parsed.origin+'/rest/v1/rpc/hd1_rpc';this.key=serviceKey;this.transport=transport;
  }
  /** Do not retry ambiguous mutations: inspect durable state using a separate read. */
  async rpc(operation,payload={}) {return this.request('hd1_rpc',operation,payload);}
  /** Dedicated STABLE SQL function: no coordinator mutation lock or operational journals. */
  async publicRead(operation,payload={}) {return this.request('hd1_public',operation,payload);}
  /** Service-only STABLE inspection of the recovery journal, never a row-locking RPC. */
  async recoveryRead(operation='inspect',payload={}) {return this.request('hd1_recovery_read',operation,payload);}
  async request(functionName,operation,payload) {
    const response=await this.transport(this.endpoint.replace(/hd1_rpc$/,functionName),{
      method:'POST',headers:{'Content-Type':'application/json',apikey:this.key,Authorization:'Bearer '+this.key},
      body:JSON.stringify({operation,payload}),signal:AbortSignal.timeout(10000)
    });
    if(!['hd1_public','hd1_recovery_read'].includes(functionName)) {
      if(!response.ok)throw Error('storage_unavailable');
      return response.json();
    }
    // Bound even a misconfigured/unexpected backend before JSON parsing.
    const reader=response.body.getReader(),chunks=[];let length=0;
    try {
      while(true) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>PUBLIC_RESPONSE_BYTES)throw Error('public_response_too_large');chunks.push(value);}
    }finally{await reader.cancel();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const result=JSON.parse(new TextDecoder().decode(bytes));
    if(!response.ok) {
      if(operation==='readiness'&&(result?.code==='P0001'&&result.message==='invalid_query'||result?.code==='PGRST202'))throw Error('schema_upgrade_required');
      throw Error('storage_unavailable');
    }
    return result;
  }
  async read() {return this.rpc('read');}
}
/** Migration 004 explicitly attests the finite-authority contract; 003 readiness is insufficient. */
export async function publisherReadiness(storage,payload={}) {
  let readiness;
  try {readiness=await storage.publicRead('readiness',payload);}
  catch(error) {
    if(!['invalid_query','unsupported_operation','schema_upgrade_required'].includes(error.message))throw error;
  }
  if(readiness?.capability_revision!==4)return {available:false,code:'schema_upgrade_required',required_capability_revision:4};
  return readiness;
}
/** Recovery is additive: ordinary revision-4 publishers remain compatible, recovery requires 007. */
export async function recoveryReadiness(storage) {
  const ready=await publisherReadiness(storage);
  return ready.recovery_capability_revision===7?ready:{available:false,code:'recovery_schema_upgrade_required'};
}
/** Adapt the distinct attempt journal to the unchanged single-sign issuer pipeline. */
export function recoveryStorage(storage,recovery,scope,job) {
  return {
    async read() {
      const [state,journal]=await Promise.all([storage.read(),storage.rpc('recovery_inspect')]);
      if(journal?.id!==recovery)throw Error('recovery_mismatch');
      return {...state,claims:[journal.attempt]};
    },
    rpc:(operation,payload={})=>storage.rpc('recovery_'+operation,{...payload,recovery,scope,job})
  };
}
/** Public status whitelist never exposes raw journals, preparation details or credentials. */
export function publicStatus(claim,scope=null) {
  const retryable=['queued','broadcast_unknown','broadcast_pending'].includes(claim.state);
  let retryCode=null;
  if(retryable&&claim.attempts>=4)retryCode='retry_exhausted';
  if(retryable&&scope&&typeof scope==='object') {
    if(!scope.claims?.includes(claim.id))retryCode='claim_outside_scope';
    else if(claim.raw) {
      if(scope.reservations?.[claim.id]?.generation!==claim.generation)retryCode='claim_outside_scope';
      else if(scope.broadcasts>=scope.max_transactions)retryCode='broadcast_budget_exhausted';
    }else if(scope.transactions>=scope.max_transactions)retryCode='transaction_budget_exhausted';
    else if(scope.fee_units>=scope.max_fee_units||scope.max_new_locked_units-scope.new_locked_units<NETWORK.dust)retryCode='spend_budget_exhausted';
  }
  return {status:['signing_started','signing_unknown'].includes(claim.state)?'signing_unknown':claim.state,
    receipt_id:claim.id,code:claim.state,retryable,
    publication_retryable:retryable&&!retryCode,retry_code:retryCode,
    provisional_epoch:claim.epoch,actual_epoch:claim.actual_epoch,txid:claim.txid,
    confirmations:claim.confirmations,derived_moves:claim.moves,derived_points:claim.points};
}
