import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublisher } from '../leaderboard/publisher.js';
import { canonical, receiptId } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit } from '../leaderboard/issuer.js';
import { chainFixture, databaseFixture, config, payment } from './publisher-fixture.js';

const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
const tick=(storage,chain)=>runPublisher(storage,config,{fetch:chain.fetch});

async function setupPending() {
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  assert.equal((await tick(storage,chain)).code,'ready');
  assert.equal((await admit(storage,verified)).state,'queued');
  return {db,storage,chain};
}

test('a newly mined ordinary block during acquisition does not reject unchanged marker history',async()=>{
  const {db,storage,chain}=await setupPending();
  try {
    let reads=0;
    chain.hooks.any=path=>{
      if(path==='/info'&&++reads===2)chain.mine();
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(c=>c.id===verified.id);
    assert(reads>=3);
    assert(row.raw&&row.txid,'unsigned claim progresses to exact signed bytes');
    assert.equal(chain.broadcasts.length,1,'one broadcast, no duplicated spend');
    assert.equal((await storage.read()).coordinator.paused,false);
  }finally {await db.close();}
});

test('an ordinary block mined between SQL prepare and pre-sign validation is rechecked',async()=>{
  const {db,storage,chain}=await setupPending();
  try {
    let reads=0;
    chain.hooks.any=path=>{
      if(path==='/info'&&++reads===3)chain.mine();
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(c=>c.id===verified.id);
    assert(reads>=3);
    assert(row.raw&&row.txid,'validated canonical extension can be signed');
    assert.equal(row.attempts,1);
    assert.equal(chain.broadcasts.length,1);
  }finally {await db.close();}
});

test('replacing the pinned block during acquisition still fails closed without signing',async()=>{
  const {db,storage,chain}=await setupPending();
  try {
    let reads=0;
    chain.hooks.any=path=>{
      if(path==='/info'&&++reads===2){
        chain.blocks.pop();
        chain.mine([payment('replacement-fork')]);
        chain.mine();
      }
    };
    await tick(storage,chain);
    const row=(await storage.read()).claims.find(c=>c.id===verified.id);
    assert.equal(row.raw,null);
    assert.equal(row.txid,null);
    assert.equal(row.attempts,0);
    assert.equal(chain.broadcasts.length,0);
    assert.equal((await storage.publicRead('readiness')).code,'history_changed');
  }finally {await db.close();}
});

test('established-name preflight reuses a verified UTXO snapshot without extra address read',async()=>{
  const {db,storage,chain}=await setupPending();
  try {
    await tick(storage,chain);
    const signed=(await storage.read()).claims.find(c=>c.id===verified.id);
    assert(signed.raw&&signed.txid);
    chain.mine([signed.raw]);
    await tick(storage,chain);
    chain.calls.length=0;
    await tick(storage,chain);
    assert.equal(chain.calls.filter(path=>path.startsWith('/unspent/')).length,1,
      'existing name-head verification and funding selection share the same bounded read');
  }finally {await db.close();}
});
