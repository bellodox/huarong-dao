import test from 'node:test';
import assert from 'node:assert/strict';
import probeWorker, { probeFetch, probeSocket, runProbe, interpret, summarizeError } from './rod-transport-probe.worker.js';

function fakeSocket(ok = true, error = Error('failed')) {
  let closes = 0;
  const socket = { opened: ok ? Promise.resolve({}) : Promise.reject(error),
    closed: Promise.resolve(), close: () => { closes++; } };
  return { socket, count: () => closes };
}

function apiResponse(result = { chain: 'main', blocks: 4272879 }, status = 200) {
  return new Response(JSON.stringify({error:null,result}), {status,headers:{'content-type':'application/json'}});
}

test('all green: exact /info over port 1234; TCP and TLS probes use fixed host/port only', async () => {
  const requested = [], conns = [];
  const output = await runProbe({
    fetcher: async (url, options) => { requested.push({ url, options }); return apiResponse(); },
    connectFn: (addr, opts) => { conns.push({addr, opts}); return fakeSocket().socket; }
  });
  assert.deepEqual(requested.map(r => r.url), ['https://api.spacexpanse.org:1234/info']);
  assert.equal(requested[0].options.redirect, 'manual');
  assert.equal(requested[0].options.cache, undefined);
  assert.equal(output.fetch.blocks, 4272879);
  assert.equal(output.fetch.ok, true);
  assert.equal(output.tcp.ok, true);
  assert.equal(output.tls.ok, true);
  assert.deepEqual(conns.map(x => x.opts.secureTransport), ['off', 'on']);
  assert(conns.every(x => x.addr.hostname === 'api.spacexpanse.org' && x.addr.port === 1234));
});

test('DNS-style fetch failure is distinguished from TLS success', async () => {
  const err = Object.assign(new TypeError('fetch failed'), {cause: Object.assign(Error('getaddrinfo ENOTFOUND'), {code:'ENOTFOUND'})});
  const output = await runProbe({fetcher: async () => {throw err;}, connectFn: () => fakeSocket().socket });
  assert.equal(output.fetch.error.category, 'dns_possible');
  assert.equal(output.fetch.error.code, 'ENOTFOUND');
  assert.match(output.interpretation, /TCP and TLS connect/);
});

test('TLS-specific error is exposed only as bounded sanitized details', async () => {
  const failure = Object.assign(Error('certificate has expired at https://api.spacexpanse.org:1234/info'), {code:'CERT_HAS_EXPIRED'});
  const outcome = await runProbe({
    fetcher: async () => {throw failure;},
    connectFn: (_, opts) => opts.secureTransport === 'off' ? fakeSocket().socket : fakeSocket(false, failure).socket
  });
  assert.equal(outcome.tcp.ok, true);
  assert.equal(outcome.tls.ok, false);
  assert.equal(outcome.tls.error.category, 'tls_possible');
  assert(!JSON.stringify(outcome).includes('https://api.spacexpanse.org:1234/info at'));
  assert.match(outcome.interpretation, /certificate chain/);
});

test('TCP denied identifies platform restriction and uses no plaintext request', async () => {
  const failure = new Error('proxy request failed, cannot connect to the specified address');
  const conn = fakeSocket(false, failure);
  const output = await runProbe({fetcher:async()=>{throw TypeError('fetch failed');}, connectFn: () => conn.socket});
  assert.equal(output.tcp.error.category, 'platform_policy_possible');
  assert.equal(output.tls.error.category, 'platform_policy_possible');
  assert.equal(conn.count(), 2);
});

test('HTTP rejection is not conflated with DNS/TLS failure', async () => {
  const result = await probeFetch(async () => apiResponse({}, 503));
  assert.equal(result.connected, true);
  assert.equal(result.http_status, 503);
  assert.equal(result.ok, false);
});

test('no arbitrary destination, no credentials in logs or queries, no non-probe path', async () => {
  for (const path of ['/api/score','/probe?url=https://attacker.test','/']) {
    const response = await probeWorker.fetch(new Request('https://probe.test'+path));
    assert.equal(response.status, 404);
  }
  assert.equal((await probeWorker.fetch(new Request('https://probe.test/probe',{method:'POST'}))).status,404);
  const message = summarizeError(Error('bearer secret-token https://api.spacexpanse.org:1234/info'));
  assert(!message.message.includes('secret-token'));
  assert(!message.message.includes('spacexpanse.org'));
  assert.match(message.message, /redacted/);
});

test('classification handles timeout and TCP failure without claiming DNS certainty', async () => {
  assert.equal(summarizeError(Object.assign(Error('request timed out'),{name:'TimeoutError'})).category,'timeout');
  assert.match(interpret({fetch:{ok:false},tcp:{ok:false},tls:{ok:false}}),/remain possible/);
});


test('3xx HTTP redirect is observed but never followed by Workers probe', async () => {
  const calls = [];
  const response = await probeFetch(async (url, options) => {
    calls.push({url, redirect: options.redirect});
    return new Response('', {status: 302, headers:{location:'https://untrusted.example/redirect'}});
  });
  assert.deepEqual(calls, [{url:'https://api.spacexpanse.org:1234/info',redirect:'manual'}]);
  assert.equal(response.ok, false);
  assert.equal(response.connected, true);
  assert.equal(response.http_status, 302);
  assert.equal(response.response_shape, 'redirect_rejected');
  assert(!JSON.stringify(response).includes('untrusted.example'));
});

const APP_ADDRESS='RCdhuRDQkwM5aYo4zTCWWk6KQEdFGQByu6';
const MARKER_ADDRESS='RFoscLnDa1fuff9exRhy4SkeKzTet1Yxpc';
const KNOWN_TXID='439112cbfdcec5301cd3302eab22749186382a388b412405966181953e95348c';
const EXPECTED_PATHS=[
  '/info', '/hash/0', '/range/4275105?offset=1',
  `/history/${MARKER_ADDRESS}?offset=0`, `/unspent/${APP_ADDRESS}`,
  `/transaction/${KNOWN_TXID}`, '/mempool'
];
function fixtureEndpoints(fetchOverrides={}) {
  const requested=[];
  const fetcher=async (url,init)=>{
    const path=new URL(url).pathname+new URL(url).search;
    requested.push({url,path,init});
    if(fetchOverrides[path])return fetchOverrides[path]();
    const data=path==='/info'?{chain:'main',blocks:4275105}:
      path==='/hash/0'?'5d4b20be4fc87d2333aea5235d9de1c685696fc935f806a9ffd71c9f9abf3c57':
      path.startsWith('/range/')?[{height:4275105,tx:[]}]:
      path.startsWith('/history/')?{txcount:1,tx:[KNOWN_TXID]}:
      path.startsWith('/unspent/')?[{height:4272609,index:0,value:1000000,txid:KNOWN_TXID}]:
      path.startsWith('/transaction/')?{hex:'00',height:4272609}:
      path==='/mempool'?{minrelaytxfee:0.0001,mempoolminfee:0.0001}:null;
    if(data===null)throw Error('unexpected_probe_route '+path);
    return apiResponse(data);
  };
  return {fetcher,requested};
}

test('deployed full probe tests every live publisher GET route with the correct ROD addresses',async()=>{
  const {fetcher,requested}=fixtureEndpoints();
  const output=await runProbe({fetcher,connectFn:()=>fakeSocket().socket,includeApiEndpoints:true});
  assert.deepEqual(requested.map(row=>row.path),EXPECTED_PATHS);
  assert(requested.every(row=>row.url.startsWith('https://api.spacexpanse.org:1234/')));
  assert(requested.every(row=>row.init.redirect==='manual'));
  assert(requested.every(row=>row.init.method==='GET'||row.path==='/info'&&row.init.method===undefined));
  assert.equal(output.read_only,true);
  assert.deepEqual(output.publisher_reads,{ok:true,passed:7,total:7});
  assert.equal(output.endpoints.history.txcount,1);
  assert.equal(output.endpoints.unspent.utxo_count,1);
  assert.equal(output.endpoints.broadcast.tested,false);
  assert.equal(output.endpoints.broadcast.path,'/broadcast');
  assert.equal(output.public_identity.marker_address,MARKER_ADDRESS);
  assert.equal(output.public_identity.app_address,APP_ADDRESS);
  assert(!JSON.stringify(output).includes('"hex":"00"'));
});

test('full probe isolates intermittent ElectrumX history error without misdiagnosing fetch or /unspent',async()=>{
  const {fetcher}=fixtureEndpoints({[`/history/${MARKER_ADDRESS}?offset=0`]:()=>Response.json({error:{code:404,message:'ElectrumX request failed'},result:null})});
  const output=await runProbe({fetcher,connectFn:()=>fakeSocket().socket,includeApiEndpoints:true});
  assert.equal(output.fetch.ok,true);
  assert.equal(output.endpoints.unspent.ok,true);
  assert.equal(output.endpoints.history.ok,false);
  assert.equal(output.endpoints.history.api_error_kind,'electrumx_error');
  assert.equal(output.endpoints.history.api_error_code,404);
  assert.deepEqual(output.publisher_reads,{ok:false,passed:6,total:7});
  assert.match(output.interpretation,/publisher read endpoints failed/);
});

test('full probe independently reports an unspent error while history succeeds',async()=>{
  const {fetcher}=fixtureEndpoints({[`/unspent/${APP_ADDRESS}`]:()=>Response.json({error:{code:404,message:'ElectrumX request failed'},result:null})});
  const output=await runProbe({fetcher,connectFn:()=>fakeSocket().socket,includeApiEndpoints:true});
  assert.equal(output.endpoints.history.ok,true);
  assert.equal(output.endpoints.unspent.api_error_kind,'electrumx_error');
  assert.equal(output.publisher_reads.passed,6);
});

test('invalid address, non-JSON, and redirect are classified without following redirects',async()=>{
  const invalid=await fixtureEndpoints({[`/history/${MARKER_ADDRESS}?offset=0`]:()=>Response.json({error:{code:404,message:'Invalid base58 character'}})}).fetcher;
  const {probeApiEndpoint}=await import('./rod-transport-probe.worker.js');
  const rejected=await probeApiEndpoint('history',`/history/${MARKER_ADDRESS}?offset=0`,invalid);
  assert.equal(rejected.api_error_kind,'address_rejected');
  const redirect=await probeApiEndpoint('mempool','/mempool',async()=>new Response('',{status:302,headers:{location:'https://invalid.test'}}));
  assert.equal(redirect.response_shape,'redirect_rejected');
  assert(!JSON.stringify(redirect).includes('invalid.test'));
  const nonjson=await probeApiEndpoint('mempool','/mempool',async()=>new Response('<html>broken</html>'));
  assert.equal(nonjson.response_shape,'non_json');
});

test('info outage does not skip unrelated independent probes; range is explicitly skipped',async()=>{
  const {fetcher,requested}=fixtureEndpoints({'/info':()=>{throw new Error('API unavailable');}});
  const output=await runProbe({fetcher,connectFn:()=>fakeSocket().socket,includeApiEndpoints:true});
  assert.equal(output.fetch.ok,false);
  assert.equal(output.endpoints.range.skipped,true);
  assert.equal(output.endpoints.unspent.ok,true);
  assert.equal(output.endpoints.history.ok,true);
  assert(!requested.some(row=>row.path.startsWith('/range/')));
});
