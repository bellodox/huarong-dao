/**
 * Read-only build-time ROD transport diagnostics. Automatically runs via npm test
 * (node --test tests/*.test.js). This is NODE IN THE BUILD ENVIRONMENT, not a
 * deployed Cloudflare Worker isolate; results do NOT prove Worker connectivity.
 * Never reads env credentials, publishes transactions or makes database requests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const HOST = 'api.spacexpanse.org';
const PORT = 1234;
const INFO_URL = `https://${HOST}:${PORT}/info`;
const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 16384;
const KNOWN_CODES = new Set([
  'ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNREFUSED','ECONNRESET',
  'EHOSTUNREACH','ENETUNREACH','ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN','ERR_SSL_WRONG_VERSION_NUMBER','UND_ERR_CONNECT_TIMEOUT'
]);

function classify(error) {
  const code = [error?.code,error?.cause?.code].find(x => KNOWN_CODES.has(x)) ?? null;
  const raw = String(error?.cause?.message ?? error?.message ?? '');
  const combined = `${code??''} ${raw}`;
  let category = 'transport_unspecified';
  if (/ENOTFOUND|EAI_AGAIN|DNS|resolve|NXDOMAIN|name lookup/i.test(combined)) category='dns_possible';
  else if (/certificate|cert|tls|ssl|handshake|SELF_SIGNED|CERT_HAS_EXPIRED/i.test(combined)) category='tls_possible';
  else if (/ECONNREFUSED|refused/i.test(combined)) category='connection_refused';
  else if (/ETIMEDOUT|timed?\s*out|abort/i.test(combined)) category='timeout';
  else if (/ECONNRESET|reset by peer/i.test(combined)) category='connection_reset';
  else if (/EHOSTUNREACH|ENETUNREACH|unreachable/i.test(combined)) category='unreachable';
  // Fixed vocabulary only: no upstream messages, URLs, IPs, hostnames, or secrets.
  return {category,code};
}

async function dnsProbe() {
  try {
    const result = await Promise.race([
      lookup(HOST, {all:true}),
      new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})),TIMEOUT_MS))
    ]);
    return {ok:result.length>0,ipv4:result.some(x=>x.family===4),ipv6:result.some(x=>x.family===6)};
  } catch(error) {return {ok:false,error:classify(error)};}
}

function socketProbe(secure) {
  return new Promise(resolve => {
    let settled=false;
    const start=Date.now();
    let socket;
    const finish = result => {
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({...result,elapsed_ms:Date.now()-start});
    };
    const timer=setTimeout(()=>finish({ok:false,error:{category:'timeout',code:'ETIMEDOUT'}}),TIMEOUT_MS);
    try {
      socket = secure
        ? tls.connect({host:HOST,port:PORT,servername:HOST,rejectUnauthorized:true})
        : net.connect({host:HOST,port:PORT});
      socket.once(secure?'secureConnect':'connect',()=>finish({ok:true,...(secure?{authorized:socket.authorized}: {})}));
      socket.once('error',error=>finish({ok:false,error:classify(error)}));
    } catch(error) {finish({ok:false,error:classify(error)});}
  });
}

async function fetchProbe() {
  const start=Date.now();
  try {
    const response=await fetch(INFO_URL,{method:'GET',redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});
    const reader=response.body?.getReader();
    let bytes=0;const chunks=[];
    if(reader) {
      try {
        while(true) {
          const {done,value}=await reader.read();
          if(done)break;
          bytes+=value.byteLength;
          if(bytes>MAX_BODY_BYTES)return {ok:false,connected:true,http_status:response.status,body:'too_large',elapsed_ms:Date.now()-start};
          chunks.push(value);
        }
      } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    }
    let body='not_json',chain=null,blocks=null;
    try {
      const raw=Buffer.concat(chunks.map(x=>Buffer.from(x)),bytes).toString('utf8');
      const json=JSON.parse(raw);
      if(json?.error!=null)body='api_error';
      else if(json&&Object.hasOwn(json,'result')) {
        body='api_result';
        chain=json.result?.chain==='main'?'main':'other_or_missing';
        blocks=Number.isSafeInteger(json.result?.blocks)?json.result.blocks:null;
      }
    } catch {}
    return {ok:response.ok&&body==='api_result',connected:true,http_status:response.status,body,chain,blocks,elapsed_ms:Date.now()-start};
  } catch(error) {return {ok:false,connected:false,error:classify(error),elapsed_ms:Date.now()-start};}
}

// The real test is intentionally NON-GATING: transient external failures must
// not prevent build/deployment, and cannot prove behavior of deployed Workers.
test('ROD API transport diagnostics from Node build environment (non-gating)',{timeout:18000},async () => {
  const [dns,tcp,tlsResult,https]=await Promise.all([dnsProbe(),socketProbe(false),socketProbe(true),fetchProbe()]);
  const result={event:'hd1_rod_build_network_diagnostic',runtime:'node_build',not_worker_runtime:true,
    target:'api.spacexpanse.org:1234',read_only:true,timeout_ms:TIMEOUT_MS,
    dns,tcp,tls:tlsResult,https,
    conclusion:!dns.ok?'build_dns_failed':!tcp.ok?'build_tcp_failed':!tlsResult.ok?'build_tls_failed':!https.ok?'build_https_failed':'build_network_ok'};
  console.log('HD1_ROD_NETWORK_DIAGNOSTIC '+JSON.stringify(result));
  assert.equal(result.read_only,true);
  assert.equal(result.not_worker_runtime,true);
});
