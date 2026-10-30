import { SupabaseStorage,publicStatus,publisherReadiness,PUBLIC_RESPONSE_BYTES } from './storage.js';
import { ClaimError,checkOrigin,readClaim,verifyClaim } from './verify.js';
import { admit,advance } from './issuer.js';
import { publicLeaderboard } from './index.js';
import { bytesToHex,utf8,parseCanonical,canonical,receiptId,recover } from './receipt.js';
import { reconstruct } from './reconcile.js';
import { rank } from './index.js';
import { publisherConfig,runPublisher } from './publisher.js';

// Build-time modules only: the generated root relay.js is the sole runtime distribution.
export * from './profile.js';
export * from './receipt.js';
export * from './verify.js';
export * from './storage.js';
export * from './issuer.js';
export * from './index.js';
export * from './chain.js';
export * from './reconcile.js';
export * from './publisher.js';

/** Responses never serialize bindings, caught exceptions, raw journals or private keys. */
function json(value,status=200,cache=false) {
  if(utf8(JSON.stringify(value)).length>PUBLIC_RESPONSE_BYTES)throw Error('public_response_too_large');
  return Response.json(value,{status,headers:{'Cache-Control':cache?'public, max-age=5, s-maxage=5':'no-store','X-Content-Type-Options':'nosniff',...(status===429?{'Retry-After':'60'}:{})}});
}
/** Injectable local fixture boundary; no production chain adapter is presumed verified. */
export async function handleApi(request,{storage=null,issuer=null,available=false,rateSecret=null,readiness=null}={}) {
  const url=new URL(request.url);
  try {
    if(url.pathname==='/api/leaderboard' && request.method==='GET') {
      if(!storage)return json({available:false,code:'issuance_disabled',rows:[],pending:[],stale:true,rewards_enabled:false,assurance:'replayed'});
      const result=await publicLeaderboard(storage,url.searchParams);
      return json({...result,available:available===true,...(readiness?{publisher:readiness}: {})},200,true);
    }
    const match=/^\/api\/submissions\/([a-f0-9]{64})$/.exec(url.pathname);
    if(match && request.method==='GET') {
      if(!storage)return json({code:'issuance_disabled',retryable:false},503);
      const status=await storage.publicRead('status',{id:match[1]});
      return status?json(status):json({code:'not_found'},404);
    }
    if(url.pathname==='/api/score' && request.method==='POST') {
      checkOrigin(request);
      if(!available||!storage)return json({code:readiness?.code??'issuance_disabled',retryable:!!storage},503);
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

/** Runtime credentials stay server-only. GET calls only STABLE whitelisted reads. */
export async function handleRelayRequest(request,bindings={},context=null) {
  const config=publisherConfig(bindings);
  let storage=null;
  try {
    if((!config.code||bindings.HD1_READS==='true')&&bindings.SUPABASE_URL&&bindings.SUPABASE_SERVICE_KEY)
      storage=new SupabaseStorage(bindings.SUPABASE_URL,bindings.SUPABASE_SERVICE_KEY);
    let readiness={available:false,code:config.code??'initial_sync'};
    if(storage&&!config.code)readiness=await publisherReadiness(storage,{appKey:config.appKey,markerKey:config.markerKey,baseUrl:config.baseUrl});
    const response=await handleApi(request,{storage,available:!config.code&&readiness?.available===true,
      rateSecret:bindings.HD1_RATE_HMAC_KEY,readiness});
    if(request.method==='POST'&&new URL(request.url).pathname==='/api/score'&&response.status===202&&context?.waitUntil)
      context.waitUntil(runPublisher(storage,config));
    return response;
  }catch {return json({code:'backend_unavailable',retryable:true},503);}
}
/** Cron is the autonomous progress path. No HTTP route exposes this operation. */
export async function handleScheduled(bindings={}) {
  const config=publisherConfig(bindings);if(config.code)return {code:config.code};
  try {return await runPublisher(new SupabaseStorage(bindings.SUPABASE_URL,bindings.SUPABASE_SERVICE_KEY),config);}
  catch {return {code:'backend_unavailable'};}
}

/** Verify exact canonical claim/receipt bytes offline; a receipt needs a separately trusted issuer. */
export function verifyOffline(text,appKey=null) {
  if(utf8(text).length>8192)throw new ClaimError('payload_too_large',413);
  const parsed=JSON.parse(text),stage=Object.keys(parsed).length;
  if(![7,8].includes(stage))throw Error('malformed');
  const receipt=parseCanonical(text,stage),{a,...claim}=receipt;
  const verified=verifyClaim(stage===7?text:canonical(claim,7),receiptId(claim));
  if(stage===8) {
    if(!/^(02|03)[a-f0-9]{64}$/.test(appKey||''))throw Error('issuer_key_required');
    if(recover('app',canonical(claim,7),a)!==appKey)throw Error('unauthorized_app');
  }else if(appKey!==null)throw Error('unexpected_issuer_key');
  return {ok:true,profile:verified.claim.p,assurance:'replayed',receipt_id:verified.id,player:verified.player,
    moves:verified.moves,points:verified.points,canonical:canonical(receipt,stage),issuer:stage===8?appKey:null};
}
/** Reuse canonical reconstruction; consensus/completeness authentication is the caller's responsibility. */
export function reconstructOffline(text,bootstrapText) {
  const history=JSON.parse(text),bootstrap=JSON.parse(bootstrapText);
  const result=reconstruct({...history,bootstrap});
  return {ok:true,evidence:'caller_authenticated_history',...result,rankings:rank(result.receipts)};
}

const CLI_HISTORY_BYTES=16*1024*1024;
/** Node-only bounded file/stdin I/O; this function is never invoked by Worker imports. */
async function cliInput(path,maximum) {
  // Computed builtin import is deliberately unreachable in Workers; no Node compatibility flag needed.
  const builtin='node:fs';
  const stream=path==='-'?process.stdin:(await import(builtin)).createReadStream(path);
  const chunks=[];let length=0;
  for await(const chunk of stream) {
    length+=chunk.length;if(length>maximum){stream.destroy();throw Error('input_too_large');}
    chunks.push(chunk);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
/** One-shot CLI: no listener, dotenv loading, background retry or implicit live publication. */
async function runNodeCli() {
  const [command,input,extra,...rest]=process.argv.slice(2);
  try {
    let result;
    if((!command||command==='help'||command==='--help')&&!input) {
      result={ok:true,runtime:'Node.js >=24.2',commands:[
        'verify <canonical-claim-or-receipt-file|-> [trusted-app-public-key]',
        'reconstruct <authenticated-history-file|-> <pinned-bootstrap-file>',
        'status <receipt-id> (requires HD1_READS=true, SUPABASE_URL, SUPABASE_SERVICE_KEY)'
      ],issuance:false,packaged_executable:false};
    }else if(command==='verify'&&input&&!rest.length) {
      result=verifyOffline(await cliInput(input,8192),extra??null);
    }else if(command==='reconstruct'&&input&&extra&&extra!=='-'&&!rest.length) {
      result=reconstructOffline(await cliInput(input,CLI_HISTORY_BYTES),await cliInput(extra,8192));
    }else if(command==='status'&&/^[a-f0-9]{64}$/.test(input||'')&&!extra) {
      const response=await handleRelayRequest(new Request('https://relay.invalid/api/submissions/'+input),process.env);
      result={ok:response.ok,http_status:response.status,...await response.json()};
      if(!response.ok)process.exitCode=1;
    }else throw Error('usage');
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error) {
    // Neither filenames, environment values nor arbitrary parser/backend messages are printed.
    const code=/^[a-z][a-z0-9_]{0,63}$/.test(error.message)?error.message:'invalid_input';
    process.stdout.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;
  }
}
// Node 24.2+ identifies direct execution even outside any package. Worker/Node imports are inert.
if(import.meta.main===true&&typeof process!=='undefined'&&process.versions?.node) {
  runNodeCli().catch(()=>{process.exitCode=1;});
}
