import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublisher } from '../leaderboard/publisher.js';
import { createTransport } from '../leaderboard/provider.js';
import { canonical,receiptId } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit } from '../leaderboard/issuer.js';
import { databaseFixture,chainFixture,config } from './publisher-fixture.js';

const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
const electrumxFailure=()=>Response.json({
  error:{code:404,message:'ElectrumX request failed'},result:null,id:'api-server'
});
const tick=(storage,chain)=>runPublisher(storage,config,{fetch:chain.fetch});

test('publisher retries one transient ElectrumX marker-history error before signing',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    assert.equal((await tick(storage,chain)).code,'ready');
    assert.equal((await admit(storage,verified)).state,'queued');
    let attempts=0;
    chain.hooks.any=path=>{
      if(path.startsWith('/history/')&&++attempts===1)return electrumxFailure();
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(row=>row.id===verified.id);
    assert.equal(attempts>=2,true,'history GET was retried');
    assert(row?.raw&&row?.txid,'score signed despite a single read-only failure');
    assert.equal(chain.broadcasts.length,1,'broadcast only once');
    assert.equal((await storage.read()).coordinator.paused,false);
  }finally {await db.close();}
});

test('publisher retries one UTXO error after unsigned preparation without re-signing',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    assert.equal((await tick(storage,chain)).code,'ready');
    assert.equal((await admit(storage,verified)).state,'queued');
    let attempts=0;
    chain.hooks.any=path=>{
      if(path.startsWith('/unspent/')&&++attempts===2)return electrumxFailure();
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(row=>row.id===verified.id);
    assert(attempts>=3,'post-preparation UTXO query was retried');
    assert(row?.raw&&row?.txid,'signed transaction saved after validation');
    assert.equal(row.attempts,1,'exactly one broadcast attempt');
    assert.equal(chain.broadcasts.length,1);
    assert.equal((await storage.read()).coordinator.paused,false);
  }finally {await db.close();}
});

test('persistent UTXO failures still fail closed and leave unsigned claim recoverable',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    assert.equal((await tick(storage,chain)).code,'ready');
    assert.equal((await admit(storage,verified)).state,'queued');
    let calls=0;
    chain.hooks.any=path=>{
      if(path.startsWith('/unspent/')){
        calls++;
        // Funding succeeds, but all three post-preparation validation reads fail.
        if(calls>=2)return electrumxFailure();
      }
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(row=>row.id===verified.id);
    assert.equal(calls,4,'two retries, then fail closed');
    assert.equal(row.state,'unsigned_preparing');
    assert.equal(row.raw,null);
    assert.equal(row.txid,null);
    assert.equal(row.attempts,0);
    assert.equal(chain.broadcasts.length,0);
    assert.equal((await storage.read()).coordinator.paused,true);
    assert.equal((await storage.publicRead('readiness')).code,'provider_unavailable');
    await db.exec("update public.hd1_claims set expires=clock_timestamp()-interval '1 second';");
    chain.hooks.any=()=>undefined;
    await tick(storage,chain);
    const recovered=(await storage.read()).claims.find(row=>row.id===verified.id);
    assert(recovered.raw&&recovered.txid,'expired unsigned lease recovered after transport restored');
    assert.equal(chain.broadcasts.length,1,'single signed transaction was broadcast once');
  }finally {await db.close();}
});

test('address retries never apply to POST, non-ElectrumX errors or unrelated GET routes',async()=>{
  const calls=[];
  const client=createTransport({baseUrl:'https://api.test',retries:0,addressReadRetries:2,retryDelayMs:0,sleep:async()=>{},
    fetch:async(url,init)=>{
      const path=new URL(url).pathname;
      calls.push({path,method:init.method??'GET'});
      return path==='/unspent/RTest'?electrumxFailure():Response.json({error:{code:404,message:'Other error'},result:null});
    }});
  await assert.rejects(client.get('/unspent/RTest'),/provider_unavailable/);
  assert.equal(calls.length,3);
  calls.length=0;
  await assert.rejects(client.get('/history/RTest'),/provider_error/);
  assert.equal(calls.length,1);
  calls.length=0;
  await assert.rejects(client.get('/info'),/provider_error/);
  assert.equal(calls.length,1);
  calls.length=0;
  await assert.rejects(client.post('/broadcast',{raw:'00'}),/provider_error/);
  assert.equal(calls.length,1,'POST never automatically retried');
});
