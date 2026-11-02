/**
 * Read-only Cloudflare Workers transport probe for the ROD API.
 * Runs independently of the game Worker: no WIF, Supabase, signing or broadcast.
 * Tests all publisher GET routes using the known public deployment identity.
 * Static public identities MUST be updated if the app/marker keys change.
 * Test on Cloudflare's edge with: wrangler dev --remote --config tests/wrangler.rod-probe.jsonc
 */
const HOST = 'api.spacexpanse.org';
const PORT = 1234;
const INFO_URL = `https://${HOST}:${PORT}/info`;
const TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 16384;
const MAX_ENDPOINT_RESPONSE_BYTES = 4000000;
// Public mainnet identity already confirmed by the operator; never read secret bindings.
const PUBLIC_APP_ADDRESS = 'RCdhuRDQkwM5aYo4zTCWWk6KQEdFGQByu6';
const PUBLIC_MARKER_ADDRESS = 'RFoscLnDa1fuff9exRhy4SkeKzTet1Yxpc';
const CONFIRMED_TRANSACTION = '439112cbfdcec5301cd3302eab22749186382a388b412405966181953e95348c';
const HEX64 = /^[a-f0-9]{64}$/;
const ENDPOINT_ROOT = `https://${HOST}:${PORT}`;


const ALLOWED_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED', 'ERR_SSL_WRONG_VERSION_NUMBER'
]);

/** Regex categorization is suggestive, not authoritative; retain a sanitized message. */
export function summarizeError(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  const cause = error?.cause;
  const code = [error?.code, cause?.code].find(value => ALLOWED_ERROR_CODES.has(value)) ?? null;
  const combined = [message, String(cause?.message ?? ''), code ?? ''].join(' ');
  let category = 'unclassified';
  if (/ENOTFOUND|EAI_AGAIN|\bDNS\b|resolve|NXDOMAIN|name lookup/i.test(combined)) category = 'dns_possible';
  else if (/certificate|\bcert\b|\bTLS\b|\bSSL\b|handshake|hostname mismatch|SELF_SIGNED|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY/i.test(combined)) category = 'tls_possible';
  else if (/ECONNREFUSED|connection refused/i.test(combined)) category = 'connection_refused';
  else if (/ETIMEDOUT|timed?\s*out|AbortError|TimeoutError|aborted/i.test(combined)) category = 'timeout';
  else if (/disallowed|blocked|not permitted|port.*prohibited|proxy request failed|TCP Loop/i.test(combined)) category = 'platform_policy_possible';
  else if (/ECONNRESET|reset by peer|connection reset/i.test(combined)) category = 'connection_reset';
  else if (/network|connect|fetch failed|socket/i.test(combined)) category = 'transport_unspecified';
  // Avoid echoing endpoint URLs, query strings, authorization values or private addresses.
  const safeMessage = message.slice(0, 300)
    .replace(/https?:\/\/[^\s,;)}]+/gi, '[url]')
    .replace(/(?:authorization|bearer|password|secret|token)[=: ]+[^\s,;)}]+/gi, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .slice(0, 180);
  const name = /^(?:[A-Z][A-Za-z]*Error|Error)$/.test(String(error?.name ?? '')) ? error.name : 'Error';
  return { name, code, category, message: safeMessage };
}

function elapsed(start, now) { return Math.max(0, Math.round(now() - start)); }

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return { response_shape: 'no_body' };
  let received = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) return { response_shape: 'too_large' };
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    // ROD API uses {error: null, result: {chain, blocks, ...}}.
    const result = body?.result;
    if (body?.error != null) return { response_shape: 'api_error', api_error_code: Number.isInteger(body.error?.code) ? body.error.code : null };
    return { response_shape: 'json', chain: typeof result?.chain === 'string' ? result.chain.slice(0, 24) : null,
      blocks: Number.isSafeInteger(result?.blocks) ? result.blocks : null };
  } catch { return { response_shape: 'non_json' }; }
}

export async function probeFetch(fetcher = globalThis.fetch, now = () => performance.now()) {
  const start = now();
  try {
    // Same URL, native fetch receiver and redirect policy as the production provider.
    const response = await fetcher.call(globalThis, INFO_URL, {
      redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    // Workers only supports follow/manual. Manual must reject redirects itself.
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch {}
      return { ok: false, connected: true, http_status: response.status,
        elapsed_ms: elapsed(start, now), response_shape: 'redirect_rejected' };
    }
    const body = await boundedResponse(response);
    return { ok: response.ok && body.response_shape === 'json', connected: true,
      http_status: response.status, elapsed_ms: elapsed(start, now), ...body };
  } catch (error) {
    return { ok: false, connected: false, elapsed_ms: elapsed(start, now), error: summarizeError(error) };
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), {name:'TimeoutError'})), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

export async function probeSocket(connectFn, secureTransport, now = () => performance.now()) {
  const start = now();
  let socket;
  try {
    socket = connectFn({ hostname: HOST, port: PORT }, { secureTransport });
    // Sockets may reject closed after cancellation; observe it to avoid unhandled rejection.
    void socket.closed?.catch(() => {});
    await withTimeout(socket.opened, TIMEOUT_MS);
    return { ok: true, elapsed_ms: elapsed(start, now) };
  } catch (error) {
    return { ok: false, elapsed_ms: elapsed(start, now), error: summarizeError(error) };
  } finally {
    try { socket?.close(); } catch {}
  }
}

export function interpret({ fetch, tcp, tls }) {
  if (fetch.ok) return 'ROD HTTPS fetch works from this Cloudflare Worker. An earlier failure may be transient or specific to the game Worker deployment.';
  if (fetch.connected) return 'Network connection reached an HTTP server. Examine HTTP status and response shape; this is not a TCP connection failure.';
  if (tcp.ok && tls.ok) return 'TCP and TLS connect, but native fetch fails. Investigate Workers fetch handling, custom-port routing and HTTP-level behavior.';
  if (tcp.ok && !tls.ok) return 'TCP succeeds but TLS fails. Inspect certificate chain, SNI, HTTPS service and TLS configuration.';
  if (!tcp.ok && !tls.ok) return 'Both socket probes failed. DNS, routing, firewall, Cloudflare socket policy and port access remain possible; read the error categories.';
  return 'Probes disagree or are inconclusive. Interpret their error details individually.';
}

/**
 * Read the full API envelope with a bounded byte cap. Never return raw responses:
 * /transaction can include signed raw bytes, and /mempool can be very large.
 */
async function boundedApiEnvelope(response) {
  const reader = response.body?.getReader();
  if (!reader) return { shape:'no_body' };
  const chunks=[];
  let total=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      total+=value.byteLength;
      if (total>MAX_ENDPOINT_RESPONSE_BYTES) return {shape:'too_large'};
      chunks.push(value);
    }
  } finally {
    try {await reader.cancel();} catch {}
    reader.releaseLock();
  }
  const bytes=new Uint8Array(total);
  let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try {
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(body,'error'))return {shape:'invalid_envelope'};
    return {shape:'json',body};
  } catch {return {shape:'non_json'};}
}

function apiErrorKind(error) {
  const message=String(error?.message??'');
  if (/electrumx/i.test(message))return 'electrumx_error';
  if (/base58|address|checksum/i.test(message))return 'address_rejected';
  if (/history too large/i.test(message))return 'history_too_large';
  return 'api_error';
}

function resultSummary(key, result) {
  if(key==='genesis')return {valid_hash:typeof result==='string'&&HEX64.test(result)};
  if(key==='range')return {blocks_returned:Array.isArray(result)?result.length:null};
  if(key==='history')return {txcount:Number.isSafeInteger(result?.txcount)?result.txcount:null,
    page_count:Array.isArray(result?.tx)?result.tx.length:null};
  if(key==='unspent')return {utxo_count:Array.isArray(result)?result.length:null};
  if(key==='transaction')return {has_raw:typeof result?.hex==='string'&&/^[a-f0-9]+$/.test(result.hex)};
  if(key==='mempool')return {min_relay_fee_present:Number.isFinite(result?.minrelaytxfee)&&result.minrelaytxfee>=0&&
    Number.isFinite(result?.mempoolminfee)&&result.mempoolminfee>=0};
  return {};
}

function validResult(key,result,summary) {
  switch(key) {
    case 'genesis': return summary.valid_hash;
    case 'range': return Array.isArray(result)&&result.length===1;
    case 'history': return Number.isSafeInteger(summary.txcount)&&summary.txcount>=0&&
      Array.isArray(result.tx)&&result.tx.length<=10&&result.tx.every(id=>typeof id==='string'&&HEX64.test(id));
    case 'unspent': return Array.isArray(result)&&result.every(row=>typeof row?.txid==='string'&&HEX64.test(row.txid)&&
      Number.isSafeInteger(row.index)&&Number.isSafeInteger(row.value)&&Number.isSafeInteger(row.height));
    case 'transaction': return summary.has_raw===true;
    case 'mempool': return result!==null&&typeof result==='object'&&!Array.isArray(result)&&summary.min_relay_fee_present;
    default: return false;
  }
}

/** One fixed-host, GET-only endpoint check. Safe, summarized, and redirect-rejecting. */
export async function probeApiEndpoint(key,path,fetcher=globalThis.fetch,now=()=>performance.now()) {
  const start=now();
  const publicPath=path;  // Constructed from fixed public identity; never user-controlled.
  try {
    const response=await fetcher.call(globalThis,ENDPOINT_ROOT+publicPath,{
      method:'GET',redirect:'manual',signal:AbortSignal.timeout(TIMEOUT_MS)
    });
    if(response.status>=300&&response.status<400) {
      try {await response.body?.cancel();} catch {}
      return {ok:false,path:publicPath,elapsed_ms:elapsed(start,now),http_status:response.status,
        response_shape:'redirect_rejected'};
    }
    const {shape,body}=await boundedApiEnvelope(response);
    const entry={ok:false,path:publicPath,elapsed_ms:elapsed(start,now),http_status:response.status,response_shape:shape};
    if(shape!=='json')return entry;
    if(body.error!==null&&body.error!==undefined)return {...entry,api_error_code:Number.isInteger(body.error?.code)?body.error.code:null,
      api_error_kind:apiErrorKind(body.error)};
    if(!response.ok||!Object.hasOwn(body,'result'))return entry;
    const summary=resultSummary(key,body.result);
    return {...entry,...summary,ok:validResult(key,body.result,summary)};
  }catch(error){return {ok:false,path:publicPath,elapsed_ms:elapsed(start,now),error:summarizeError(error)};}
}

/** Exact routes used by the live publisher. /broadcast is intentionally never requested. */
export async function probePublisherEndpoints(fetcher=globalThis.fetch,now=()=>performance.now(),tipHeight=null) {
  const targets={
    genesis:'/hash/0',
    range:Number.isSafeInteger(tipHeight)&&tipHeight>=0?`/range/${tipHeight}?offset=1`:null,
    history:`/history/${PUBLIC_MARKER_ADDRESS}?offset=0`,
    unspent:`/unspent/${PUBLIC_APP_ADDRESS}`,
    transaction:`/transaction/${CONFIRMED_TRANSACTION}`,
    mempool:'/mempool'
  };
  const checks={};
  for(const [key,path] of Object.entries(targets)) {
    checks[key]=path===null?{ok:false,skipped:true,reason:'tip_unavailable'}:
      await probeApiEndpoint(key,path,fetcher,now);
  }
  checks.broadcast={tested:false,skipped:true,reason:'mutating_endpoint_post_never_probed',method:'POST',path:'/broadcast'};
  return checks;
}

export async function runProbe({ fetcher = globalThis.fetch, connectFn, now = () => performance.now(), includeApiEndpoints = false } = {}) {
  if (typeof connectFn !== 'function') throw new TypeError('Cloudflare TCP connect() is required');
  // Deliberately sequential: only three bounded outbound operations, no retries.
  const fetch = await probeFetch(fetcher, now);
  const tcp = await probeSocket(connectFn, 'off', now);
  const tls = await probeSocket(connectFn, 'on', now);
  const output={ target: INFO_URL, read_only: true, fetch, tcp, tls, interpretation: interpret({ fetch, tcp, tls }),
    note: 'Socket failure alone does not prove DNS/TLS cause: Cloudflare restricts TCP sockets to certain destinations.' };
  if (includeApiEndpoints) {
    const endpoints={info:{...fetch,path:'/info'},...await probePublisherEndpoints(fetcher,now,fetch.ok?fetch.blocks:null)};
    const readEndpoints=['info','genesis','range','history','unspent','transaction','mempool'];
    const passed=readEndpoints.filter(key=>endpoints[key].ok).length;
    output.endpoints=endpoints;
    output.publisher_reads={ok:passed===readEndpoints.length,passed,total:readEndpoints.length};
    output.public_identity={app_address:PUBLIC_APP_ADDRESS,marker_address:PUBLIC_MARKER_ADDRESS,
      source:'pinned_public_deployment_addresses_not_runtime_key_verification'};
    if(passed!==readEndpoints.length)output.interpretation='One or more publisher read endpoints failed; inspect each endpoint result. This does not imply a Cloudflare connectivity failure.';
  }
  return output;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/probe' || url.search)
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    try {
      const { connect } = await import('cloudflare:sockets');
      const result = await runProbe({ connectFn: connect, includeApiEndpoints: true });
      return Response.json(result, { headers: { 'cache-control': 'no-store', 'x-content-type-options':'nosniff' } });
    } catch (error) {
      return Response.json({ diagnostic_failed: true, error: summarizeError(error) },
        { status: 500, headers: { 'cache-control':'no-store' } });
    }
  }
};
