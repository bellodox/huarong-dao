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
  async request(functionName,operation,payload) {
    const response=await this.transport(this.endpoint.replace(/hd1_rpc$/,functionName),{
      method:'POST',headers:{'Content-Type':'application/json',apikey:this.key,Authorization:'Bearer '+this.key},
      body:JSON.stringify({operation,payload}),signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw Error('storage_unavailable');
    if(functionName!=='hd1_public')return response.json();
    // Bound even a misconfigured/unexpected backend before JSON parsing.
    const reader=response.body.getReader(),chunks=[];let length=0;
    try {
      while(true) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>PUBLIC_RESPONSE_BYTES)throw Error('public_response_too_large');chunks.push(value);}
    }finally{await reader.cancel();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async read() {return this.rpc('read');}
}
/** Public status whitelist never exposes raw journals, preparation details or credentials. */
export function publicStatus(claim) {
  return {status:['signing_started','signing_unknown'].includes(claim.state)?'signing_unknown':claim.state,
    receipt_id:claim.id,code:claim.state,retryable:['queued','broadcast_unknown','broadcast_pending'].includes(claim.state),
    provisional_epoch:claim.epoch,actual_epoch:claim.actual_epoch,txid:claim.txid,
    confirmations:claim.confirmations,derived_moves:claim.moves,derived_points:claim.points};
}
