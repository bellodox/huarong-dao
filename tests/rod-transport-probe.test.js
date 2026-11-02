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
  assert.equal(requested[0].options.redirect, 'error');
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
