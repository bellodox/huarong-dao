import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { reconcile } from '../leaderboard/reconcile.js';
import { leaderboardPage } from '../leaderboard/index.js';
import { advance } from '../leaderboard/issuer.js';
test('atomic projection rebuild from chain, failed rebuild rollback, journal retained, stale cursor',async()=>{
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  const rpc=async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
  const storage={rpc,read:()=>rpc('read')};
  const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
  try {
    await reconcile(storage,{history:async()=>history});
    const state=await storage.read();assert.equal(state.coordinator.paused,false);
    assert.equal(leaderboardPage(state,new URLSearchParams()).rows[0].points,1160);
    const halted=await rpc('halt');
    await assert.rejects(rpc('rebuild',{revision:halted.revision,epoch:2900,head:null,snapshot:{receipts:[{id:'missing fields'}]}}));
    assert.equal((await db.query('select count(*)::integer as count from public.hd1_receipts')).rows[0].count,2);
    assert.equal((await storage.read()).coordinator.paused,true);
    // Rebuild does not drop private unsigned decisions or exact raw outbox.
    await db.exec("insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision,raw,txid) values(repeat('a',64),'bytes','02'||repeat('1',64),'Player','wings',2900,120,1,'broadcast_unknown',0,'00',repeat('b',64));");
    await reconcile(storage,{history:async()=>history});
    assert.equal((await storage.read()).claims[0].raw,'00');
    await assert.rejects(reconcile(storage,{history:async()=>{throw Error('source unavailable');}}),/source unavailable/);
    assert.equal((await storage.read()).coordinator.paused,true);
    const cursor=btoa(JSON.stringify({fingerprint:'wrong',offset:0}));
    assert.throws(()=>leaderboardPage(state,new URLSearchParams({cursor})),/stale_cursor/);
  }finally{await db.close();}
});

test('reorg projection rollback reconsiders unsigned identical claims but never re-signs a signed claim',async()=>{
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  const rpc=async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
  const storage={rpc,read:()=>rpc('read')};
  const row={id:'c'.repeat(64),txid:'d'.repeat(64),player:'02'+'1'.repeat(64),nickname:'Player',layout:'wings',epoch:10,moves:120,points:100,height:1,transaction_index:0,output_index:0,receipt:'fixture'};
  const candidate={id:'b'.repeat(64),bytes:'same-player-signed-bytes',player:row.player,nickname:'Player',layout:'wings',epoch:10,moves:124,points:99};
  async function rebuild(receipts){const halted=await rpc('halt');return rpc('rebuild',{revision:halted.revision,epoch:10,head:null,snapshot:{receipts,stale:false,height:10}});}
  try {
    await rebuild([row]);assert.equal((await rpc('admit',candidate)).state,'not_improved');
    await rebuild([{...row,moves:130}]);
    const retry=await rpc('admit',candidate);assert.equal(retry.state,'queued');assert.equal(retry.bytes,candidate.bytes);
    assert.equal((await rpc('admit',candidate)).id,candidate.id);
    assert.equal((await storage.read()).claims.length,1);
    // A removed confirmed transaction retains its exact immutable spend, halts issuance,
    // and advance must not invoke chain preparation/signing or broadcast.
    await db.exec("update public.hd1_claims set state='confirmed',raw='00',txid=repeat('e',64);");
    await rebuild([{...row,moves:130}]);
    const state=await storage.read();assert.equal(state.coordinator.paused,true);
    assert.equal(state.claims[0].state,'reorged');assert.equal(state.claims[0].raw,'00');
    assert.equal((await rpc('admit',candidate)).state,'reorged');
    const forbidden=new Proxy({},{get(){throw Error('signed reorg must not touch chain');}});
    assert.equal((await advance(storage,forbidden,null,null,candidate.id)).state,'reorged');
  }finally{await db.close();}
});
