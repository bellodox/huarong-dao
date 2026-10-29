import { SupabaseStorage,publicStatus,PUBLIC_RESPONSE_BYTES } from './leaderboard/storage.js';
import { ClaimError,checkOrigin,readClaim,verifyClaim } from './leaderboard/verify.js';
import { admit,advance } from './leaderboard/issuer.js';
import { publicLeaderboard } from './leaderboard/index.js';
import { bytesToHex,utf8 } from './leaderboard/receipt.js';

/** Responses never serialize bindings, caught exceptions, raw journals or private keys. */
function json(value,status=200,cache=false) {
  if(utf8(JSON.stringify(value)).length>PUBLIC_RESPONSE_BYTES)throw Error('public_response_too_large');
  return Response.json(value,{status,headers:{'Cache-Control':cache?'public, max-age=5, s-maxage=5':'no-store','X-Content-Type-Options':'nosniff',...(status===429?{'Retry-After':'60'}:{})}});
}
/** Injectable local fixture boundary; no production chain adapter is presumed verified. */
export async function handleApi(request,{storage=null,issuer=null,available=false,rateSecret=null}={}) {
  const url=new URL(request.url);
  try {
    if(url.pathname==='/api/leaderboard' && request.method==='GET') {
      if(!storage)return json({available:false,code:'issuance_disabled',rows:[],pending:[],stale:true,rewards_enabled:false,assurance:'replayed'});
      const result=await publicLeaderboard(storage,url.searchParams);
      return json({...result,available:available===true},200,true);
    }
    const match=/^\/api\/submissions\/([a-f0-9]{64})$/.exec(url.pathname);
    if(match && request.method==='GET') {
      if(!storage)return json({code:'issuance_disabled',retryable:false},503);
      const status=await storage.publicRead('status',{id:match[1]});
      return status?json(status):json({code:'not_found'},404);
    }
    if(url.pathname==='/api/score' && request.method==='POST') {
      checkOrigin(request);
      if(!available||!storage)return json({code:'issuance_disabled',retryable:false},503);
      // Server-only HMAC, never a reversible unsalted IP digest or a fallback key.
      const ip=request.headers.get('cf-connecting-ip');
      if(typeof rateSecret!=='string'||utf8(rateSecret).length<32||utf8(rateSecret).length>256||!ip||ip.length>64)return json({code:'issuance_disabled',retryable:false},503);
      const key=await crypto.subtle.importKey('raw',utf8(rateSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const bucket=bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC',key,utf8('hd1-admission-ip-v1\u0000'+ip))));
      // A per-IP rejection must not spend the shared 60/minute admission budget.
      const ipRate=await storage.rpc('rate',{bucket});
      const rate=ipRate.code==='ok'?await storage.rpc('rate',{bucket:'global'}):ipRate;
      if(rate.code!=='ok')return json({code:'rate_limited',retryable:true},429);
      const verified=verifyClaim(await readClaim(request),request.headers.get('idempotency-key'));
      let result=await admit(storage,verified);
      if(result.code) {
        const status={queue_full:429,name_conflict:409,epoch_changed:409,idempotency_conflict:409}[result.code]||503;
        return json({code:result.code,retryable:status>=429},status);
      }
      if(issuer && ['queued','unsigned_preparing','signed_persisted','broadcast_pending','broadcast_unknown'].includes(result.state)) {
        try {result=await advance(storage,issuer.chain,issuer.secret,issuer.markerKey,verified.id);}
        catch {result=(await storage.read()).claims.find(row=>row.id===verified.id);}
      }
      if(result.code)result=(await storage.read()).claims.find(row=>row.id===verified.id);
      return json(publicStatus(result),result.state==='not_improved'||result.state==='confirmed'?200:202);
    }
    return json({code:'not_found'},404);
  }catch(error) {
    if(error instanceof ClaimError)return json({code:error.code,retryable:false},error.status);
    if(['invalid_query','stale_cursor'].includes(error.message))return json({code:error.message},400);
    return json({code:'backend_unavailable',retryable:true},503);
  }
}

export default {
  async fetch(request,env) {
    if(new URL(request.url).pathname.startsWith('/api/')) {
      // Explicit read configuration only. E1 has NOT established a live chain adapter.
      const storage=env.HD1_READS==='true'&&env.SUPABASE_URL&&env.SUPABASE_SERVICE_KEY?
        new SupabaseStorage(env.SUPABASE_URL,env.SUPABASE_SERVICE_KEY):null;
      return handleApi(request,{storage,available:false,rateSecret:env.HD1_RATE_HMAC_KEY});
    }
    // No secret substitution. Even an accidentally retained legacy issuer binding is ignored.
    return env.ASSETS.fetch(request);
  }
};
