import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';
import { broadcastStored,admit } from '../leaderboard/issuer.js';
import { publicStatus } from '../leaderboard/storage.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { buildTransaction,serialize,signTransaction,FEE_POLICY } from '../leaderboard/chain.js';
import { canonical,receiptId,signApp } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { config,appKey,markerKey,secret,chainFixture,databaseFixture } from './publisher-fixture.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
const provider=(chain)=>createSpaceXpanseProvider({appKey:config.appKey,markerKey:config.markerKey,
  anchor:{height:100,hash:chain.blocks[0].hash},baseUrl:config.baseUrl,fetch:chain.fetch,retries:0,allowUnprovenNameAbsence:true});

// Synthetic live-compatible node policy; never contact a hosted provider.
function floor(chain,value=0.001) {
  const route=chain.route;chain.route=(path,init)=>path==='/mempool'?{minrelaytxfee:value,mempoolminfee:value}:route(path,init);
}
test('ordinary live relay floor permits bounded signed-size preparation and readiness',async()=>{
  const chain=chainFixture();floor(chain);
  const observation=await provider(chain).prepare({bytes:canonical(playerClaim,7)});
  const signed=signTransaction(buildTransaction(observation.prepared,signApp(playerClaim,secret),appKey,markerKey),secret);
  assert(observation.prepared.fee>=signed.raw.length/2*100);
  assert(observation.prepared.fee<=100000);
  const {db,storage}=await databaseFixture();
  try {
    const result=await runPublisher(storage,config,{fetch:chain.fetch});
    assert.equal(result.code,'ready');
    assert.equal((await storage.publicRead('readiness')).available,true);
    assert.equal(chain.broadcasts.length,0);assert.equal((await storage.read()).coordinator.generation,0);
    assert(chain.calls.includes('/mempool'));assert(!chain.calls.includes('/fee'));
  }finally{await db.close();}
});
test('fee floor is validated and never silently raises configured rate; preparation rechecks it',async()=>{
  for(const [value,code] of [[0.00101,'relay_fee_policy_incompatible'],[null,'relay_fee_unavailable'],[-1,'relay_fee_unavailable'],['0.0001','relay_fee_unavailable']]) {
    const chain=chainFixture();floor(chain,value);
    await assert.rejects(provider(chain).prepare({bytes:canonical(playerClaim,7)}),new RegExp(code));
    assert.equal(chain.broadcasts.length,0);
  }
  const chain=chainFixture();floor(chain,0.0001);const live=provider(chain);
  const observation=await live.prepare({bytes:canonical(playerClaim,7)});
  floor(chain,0.001);
  assert.equal(await live.validate(observation),true);
  await assert.rejects(live.validate({...observation,prepared:{...observation.prepared,fee:12820}}),/relay_fee_insufficient/);
  floor(chain,0.00101);
  await assert.rejects(live.validate(observation),/relay_fee_policy_incompatible/);
});
test('533-byte unsigned shape funds the 639-byte signed relay requirement within the absolute cap',async()=>{
  // Increase only synthetic receipt bytes until its unsigned transaction is exactly 533 bytes.
  const chain=chainFixture();floor(chain,0.0001);
  const prepared=(await provider(chain).prepare({bytes:canonical(playerClaim,7)})).prepared;
  let receipt;
  for(let count=1;count<400;count++) {
    const candidate=signApp({...playerClaim,m:'A'.repeat(count)},secret);
    if(serialize(buildTransaction({...prepared,fee:12820},candidate,appKey,markerKey),[new Uint8Array()]).length===533){receipt=candidate;break;}
  }
  assert(receipt);const tx=buildTransaction({...prepared,fee:12820},receipt,appKey,markerKey);
  assert.equal(serialize(tx,[new Uint8Array()]).length,533);
  // DER length varies; construction must conservatively cover the whole signed transaction.
  const signedBytes=signTransaction(tx,secret).raw.length/2;
  assert(signedBytes>=638&&signedBytes<=641);
  assert(63900>533*FEE_POLICY.perByte);
  const funded=await provider(chain).prepare({bytes:canonical({...playerClaim,m:receipt.m},7)});
  const fundedTx=buildTransaction(funded.prepared,receipt,appKey,markerKey);
  const fundedBytes=signTransaction(fundedTx,secret).raw.length/2;
  assert(funded.prepared.fee>=fundedBytes*100);
  assert(funded.prepared.fee<=100000);
  assert.doesNotThrow(()=>buildTransaction({...prepared,fee:63900},receipt,appKey,markerKey));
});
test('broadcast diagnostics retain only allowlisted categories and never retry or mutate bytes',async()=>{
  for(const [error,expected] of [[Object.assign(Error('provider_error'),{detail:{message:'min relay fee not met; SECRET'}}),'broadcast_fee_rejected'],
    [Error('provider_timeout'),'provider_timeout'],[Error('SECRET untrusted payload'),'broadcast_failed']]) {
    let attempts=0;const claim={id:'synthetic',raw:'00',txid:'ab'.repeat(32),attempts:0};
    const storage={rpc:async()=>{attempts++;return {...claim,attempts};}};
    const result=await broadcastStored(storage,{broadcast:async()=>{throw error;}},claim);
    assert.equal(result.state,'broadcast_unknown');assert.equal(result.diagnostic,expected);
    assert.equal(attempts,1);assert.equal(result.raw,claim.raw);assert(!JSON.stringify(result).includes('SECRET'));
  }
});
test('scheduler preserves broadcast diagnostic through its result channel without new persistence',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();floor(chain,0.0001);
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});await admit(storage,verified);
    chain.hooks.any=path=>path==='/broadcast'?Response.json({error:{code:-26,message:'min relay fee not met SECRET'},result:null}):undefined;
    const result=await runPublisher(storage,config,{fetch:chain.fetch});
    assert.deepEqual(result,{code:'broadcast_unknown',diagnostic:'broadcast_fee_rejected'});
    const row=(await storage.read()).claims[0];assert.equal(row.attempts,1);assert(row.raw);
    assert(!JSON.stringify(await storage.rpc('operational')).includes('SECRET'));
  }finally{await db.close();}
});
test('status separates claim retryability from exhausted finite publication authority',async()=>{
  const scope={id:'synthetic',claims:['id'],max_transactions:1,transactions:1,broadcasts:1,max_fee_units:12820,fee_units:12820,
    max_new_locked_units:1000600,new_locked_units:1000600,reservations:{id:{generation:1}}};
  const claim={id:'id',state:'broadcast_unknown',raw:'00',generation:1,attempts:1};
  const status=publicStatus(claim,scope);
  assert.equal(status.retryable,true);assert.equal(status.publication_retryable,false);assert.equal(status.retry_code,'broadcast_budget_exhausted');
  assert.equal(publicStatus(claim,{...scope,broadcasts:0}).publication_retryable,true);
  assert.equal(publicStatus({...claim,attempts:4},null).publication_retryable,false);
  assert(!JSON.stringify(status).includes('reservations'));
});
test('SQL status and leaderboard pending reflect exhausted finite authority without altering counters',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();floor(chain,0.0001);
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});await admit(storage,verified);
    const scope=await storage.rpc('finite_open',{id:crypto.randomUUID(),name:'g/huarong-lb',max_transactions:1,max_fee_units:100000,max_new_locked_units:1000600});
    await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id});
    const before=await storage.rpc('operational'),row=(await storage.read()).claims[0];
    const status=await storage.publicRead('status',{id:row.id});
    assert.equal(status.retryable,true);assert.equal(status.publication_retryable,false);assert.equal(status.retry_code,'broadcast_budget_exhausted');
    const page=await storage.publicRead('leaderboard',{scope:'lifetime',limit:20,offset:0});
    assert.equal(page.pending[0].publication_retryable,false);
    assert.deepEqual(await storage.rpc('operational'),before);
  }finally{await db.close();}
});
