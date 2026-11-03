import { NETWORK } from './chain.js';

export const PUBLIC_RESPONSE_BYTES=262144;
const failureEvidence=new WeakMap();
const BACKEND_CODES=new Map([
  ['PGRST301','authentication'],['PGRST302','authentication'],['PGRST303','authentication'],['42501','permission'],
  ['PGRST202','schema'],['PGRST203','schema'],['42P01','schema'],['42883','schema'],['42703','schema'],
  ['22P02','database_input'],['22023','database_input'],['22003','database_input'],['22007','database_input'],
  ['23502','database_constraint'],['23503','database_constraint'],['23505','database_constraint'],['23514','database_constraint'],
  ['P0001','database_exception'],['XX000','database_internal'],['57014','timeout'],['53300','upstream_unavailable'],
  ['PGRST000','upstream_unavailable'],['PGRST001','upstream_unavailable'],['PGRST002','upstream_unavailable'],['PGRST003','timeout']
]);
/** Retain only locally constructed, fixed-vocabulary evidence; never an upstream error object. */
function storageFailure(message,category,status=null,code=null) {
  const error=Error(message),backendCode=BACKEND_CODES.has(code)?code:null;
  failureEvidence.set(error,Object.freeze({category:backendCode?BACKEND_CODES.get(backendCode):category,
    ...(Number.isInteger(status)&&status>=100&&status<=599?{upstream_status:status}:{}),...(backendCode?{backend_code:backendCode}:{})}));
  return error;
}
/** Only this module can attach trusted evidence; arbitrary thrown values supply no log fields. */
export function storageDiagnostic(error) {return failureEvidence.get(error)??{category:'unexpected'};}
/** Small server-only persistence boundary. No SQL transaction spans these HTTP calls. */
export class SupabaseStorage {
  constructor(url,serviceKey,transport=fetch) {
    let parsed;
    try {
      if(typeof url!=='string'||typeof serviceKey!=='string'||!serviceKey.trim()||/[\r\n]/.test(serviceKey))throw Error();
      parsed=new URL(url);
      if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash)throw Error();
    }catch {throw storageFailure('invalid_storage_configuration','configuration');}
    this.endpoint=parsed.origin+'/rest/v1/rpc/hd1_rpc';this.key=serviceKey;this.transport=transport;
  }
  /** Do not retry ambiguous mutations: inspect durable state using a separate read. */
  async rpc(operation,payload={}) {return this.request('hd1_rpc',operation,payload);}
  /** Dedicated STABLE SQL function: no coordinator mutation lock or operational journals. */
  async publicRead(operation,payload={}) {return this.request('hd1_public',operation,payload);}
  /** Service-only STABLE inspection of the recovery journal, never a row-locking RPC. */
  async recoveryRead(operation='inspect',payload={}) {return this.request('hd1_recovery_read',operation,payload);}
  /** Service-only STABLE, bounded, allowlisted session inspection. */
  async sessionStatus(operation='recent',payload={}) {return this.request('hd_session_status',operation,payload);}
  async request(functionName,operation,payload) {
    let response;
    try {
      // Workers native fetch requires the global receiver, not this storage instance.
      response=await this.transport.call(globalThis,this.endpoint.replace(/hd1_rpc$/,functionName),{
        method:'POST',headers:{'Content-Type':'application/json',apikey:this.key,Authorization:'Bearer '+this.key},
        body:JSON.stringify({operation,payload}),signal:AbortSignal.timeout(10000)
      });
    }catch(error) {
      if(functionName==='hd1_public'&&operation==='readiness'&&['invalid_query','unsupported_operation','schema_upgrade_required'].includes(error?.message))
        throw storageFailure('schema_upgrade_required','schema');
      throw storageFailure('storage_unavailable',error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'transport');
    }
    if(!['hd1_public','hd1_recovery_read','hd_session_status'].includes(functionName)) {
      if(!response.ok)throw Error('storage_unavailable');
      return response.json();
    }
    // Bound even a misconfigured/unexpected backend before JSON parsing.
    const reader=response.body?.getReader(),chunks=[];let length=0;
    if(!reader)throw storageFailure('storage_unavailable','invalid_response',response.status);
    try {
      while(true) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>PUBLIC_RESPONSE_BYTES)throw storageFailure('public_response_too_large','response_too_large',response.status);chunks.push(value);}
    }catch(error) {
      if(failureEvidence.has(error))throw error;
      throw storageFailure('storage_unavailable',error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'transport',response.status);
    }finally{try {await reader.cancel();}catch {}}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let result;
    try {result=JSON.parse(new TextDecoder().decode(bytes));}
    catch {throw storageFailure('storage_unavailable','invalid_response',response.status);}
    if(!response.ok) {
      if(operation==='readiness'&&(result?.code==='P0001'&&result.message==='invalid_query'||result?.code==='PGRST202'))throw Error('schema_upgrade_required');
      throw storageFailure('storage_unavailable',response.status===401?'authentication':response.status===403?'permission':response.status>=500?'upstream_unavailable':'upstream_rejected',response.status,result?.code);
    }
    return result;
  }
  /** Independent session rows avoid the publisher coordinator lock. */
  async session(operation,payload={}) {return this.request('hd_session_rpc',operation,payload);}
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
