import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Extract the real transport function so this regression test needs no npm packages.
// In the full repository, tests/provider.test.js also tests the complete provider.
const source=readFileSync(new URL('../leaderboard/provider.js',import.meta.url),'utf8');
const start=source.indexOf('/** Bounded HTTPS JSON transport:');
const end=source.indexOf('/** Recompute an 80-byte header hash',start);
if(start<0||end<=start)throw new Error('provider transport test fixture not found');
const section=source.slice(start,end).replace('export function createTransport','function createTransport');
const providerError=(code,detail)=>Object.assign(new Error(code),{code,detail});
const context={
  URL,URLSearchParams,TextDecoder,AbortController,setTimeout,clearTimeout,
  PROVIDER_DEFAULTS:{baseUrl:'https://api.spacexpanse.org:1234',timeoutMs:1000,retries:2,retryDelayMs:0,maxResponseBytes:4096},
  RETRYABLE_TRANSPORT:new Set(['provider_unavailable','provider_timeout']),
  PUBLISHER_LIMIT_ERRORS:new Set(['provider_request_budget_exhausted','publisher_deadline_exceeded']),
  providerError,
  classifyEnvelope:error=>providerError('provider_error',{providerCode:error?.code??null}),
};
const createTransport=runInNewContext(`${section}\ncreateTransport`,context);
const api=()=>Response.json({error:null,result:{chain:'main',blocks:4274901}});

test('publisher uses Cloudflare-compatible manual redirect on GET and POST',async()=>{
  const requests=[];
  const fetcher=async(url,init)=>{
    assert.equal(init.redirect,'manual');
    requests.push({url,init});
    return api();
  };
  const transport=createTransport({fetch:fetcher,retries:0});
  assert.equal((await transport.get('/info')).blocks,4274901);
  assert.equal((await transport.post('/broadcast',{raw:'01'})).blocks,4274901);
  assert.deepEqual(requests.map(r=>r.url),[
    'https://api.spacexpanse.org:1234/info','https://api.spacexpanse.org:1234/broadcast']);
  assert.equal(requests[1].init.method,'POST');
});

test('publisher rejects HTTP redirect without following it, using one GET',async()=>{
  let count=0;
  const transport=createTransport({fetch:async(_url,init)=>{
    assert.equal(init.redirect,'manual');count++;
    return new Response('',{status:302,headers:{location:'https://untrusted.example/redirect'}});
  },retries:2,sleep:async()=>{}});
  await assert.rejects(transport.get('/info'),e=>e.code==='provider_http_error'&&
    e.detail?.category==='http_error'&&e.detail?.status===302&&e.detail?.path==='/info');
  assert.equal(count,1,'3xx must not be retried');
});

test('publisher rejects HTTP redirect without following or retrying POST',async()=>{
  let count=0;
  const transport=createTransport({fetch:async(_url,init)=>{
    assert.equal(init.method,'POST');count++;
    return new Response('',{status:307,headers:{location:'https://untrusted.example/broadcast'}});
  },retries:2,sleep:async()=>{}});
  await assert.rejects(transport.post('/broadcast',{raw:'01'}),e=>e.code==='provider_http_error'&&e.detail?.status===307);
  assert.equal(count,1);
});

test('429 or 5xx GET retries still work with manual redirect mode',async()=>{
  let count=0;
  const transport=createTransport({fetch:async(_url,init)=>{
    assert.equal(init.redirect,'manual');count++;
    return count===1?new Response('unavailable',{status:503}):api();
  },retries:1,sleep:async()=>{}});
  assert.equal((await transport.get('/info')).chain,'main');
  assert.equal(count,2);
});
