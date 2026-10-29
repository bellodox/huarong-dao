import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
export async function database() {
  const db=new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  return db;
}
export async function rpc(db,operation,payload={}) {
  return (await db.query('select public.hd1_rpc($1,$2::jsonb) as result',[operation,JSON.stringify(payload)])).rows[0].result;
}
export const claim=(id,moves=124)=>({id:id.repeat(64),bytes:'canonical-'+id,player:'02'+'1'.repeat(64),nickname:'Player',layout:'wings',epoch:10,moves,points:100});
test('PostgreSQL admission: strict OR, byte idempotency, reconsideration revision, queue uniqueness',async()=>{
  const db=await database();
  try {
    assert.equal((await rpc(db,'admit',claim('a',120))).code,'reconciliation_required');
    await db.exec("update public.hd1_coordinator set paused=false,epoch=10; insert into public.hd1_receipts values('confirmed','tx','02'||repeat('1',64),'Player','wings',10,130,1,1,0,0,'receipt');");
    assert.equal((await rpc(db,'admit',claim('a',120))).state,'queued');
    assert.equal((await rpc(db,'admit',claim('b',124))).state,'not_improved');
    const before=await rpc(db,'read');
    assert.equal((await rpc(db,'admit',claim('b',124))).evaluation_revision,before.coordinator.revision);
    assert.equal((await rpc(db,'admit',{...claim('a'),bytes:'changed'})).code,'idempotency_conflict');
    assert.equal((await rpc(db,'cancel',{id:'a'.repeat(64)})).state,'cancelled');
    const retried=await Promise.all(Array.from({length:8},()=>rpc(db,'admit',claim('b',124))));
    assert(retried.every(q=>q.state==='queued'));
    assert.equal((await db.query("select count(*)::integer as count from public.hd1_claims where state='queued'")).rows[0].count,1);
    assert.equal((await rpc(db,'admit',{...claim('c',110),nickname:'Other'})).code,'name_conflict');
    assert.equal((await rpc(db,'admit',{...claim('c',110),epoch:11})).code,'epoch_changed');
  }finally{await db.close();}
});
test('fenced unsigned lease, non-expiring signing barrier and immutable exact-raw outbox',async()=>{
  const db=await database();
  try {
    await db.exec("update public.hd1_coordinator set paused=false,epoch=10;");
    const queued=await rpc(db,'admit',claim('a',120));
    const prepared={inputs:[{txid:'1'.repeat(64),index:0}],head:null};
    assert.equal((await rpc(db,'prepare',{id:queued.id,owner:'incomplete',epoch:10,prepared})).code,'stale_state');
    let lease=await rpc(db,'prepare',{id:queued.id,owner:'owner-1',revision:queued.evaluation_revision,epoch:10,head:null,prepared});
    const stale={id:queued.id,owner:'owner-1',generation:lease.generation};
    await db.exec("update public.hd1_claims set expires=clock_timestamp()-interval '1 second';");
    assert.equal((await rpc(db,'begin',{...stale,revision:lease.evaluation_revision,epoch:10,head:null,prepared})).code,'stale_owner');
    let state=await rpc(db,'read');
    assert.equal((await rpc(db,'prepare',{id:queued.id,owner:'owner-2',revision:state.coordinator.revision+1,epoch:10,head:null,prepared})).state,'unsigned_preparing');
    state=await rpc(db,'read');lease=state.claims[0];
    assert(lease.generation>stale.generation);
    assert.equal((await rpc(db,'begin',{...stale,revision:state.coordinator.revision,epoch:10,head:null,prepared})).code,'stale_owner');
    const current={id:lease.id,owner:lease.owner,generation:lease.generation};
    assert.equal((await rpc(db,'begin',{...current,revision:state.coordinator.revision,epoch:10,head:null,prepared})).state,'signing_started');
    assert.equal((await rpc(db,'begin',{...current,revision:state.coordinator.revision,epoch:10,head:null,prepared})).code,'stale_owner');
    assert.equal((await rpc(db,'cancel',current)).code,'barrier_locked');
    assert.equal((await rpc(db,'prepare',{id:lease.id})).code,'signer_busy');
    assert.equal((await rpc(db,'broadcast',current)).code,'barrier_locked');
    const exact={...current,raw:'00'.repeat(150),txid:'2'.repeat(64),receipt:'receipt'};
    const stored=await rpc(db,'finalize',exact);assert.equal(stored.state,'signed_persisted');
    assert.equal((await rpc(db,'finalize',exact)).raw,exact.raw);
    assert.equal((await rpc(db,'finalize',current)).code,'idempotency_conflict');
    assert.equal((await rpc(db,'finalize',{...exact,raw:'11'.repeat(150)})).code,'idempotency_conflict');
    assert.equal((await rpc(db,'broadcast',current)).raw,exact.raw);
    assert.equal((await rpc(db,'broadcast',current)).code,'retry_later');
    assert.equal((await rpc(db,'read')).coordinator.active,lease.id);
    await rpc(db,'halt');
    assert.equal((await rpc(db,'broadcast',current)).code,'reconciliation_required');
  }finally{await db.close();}
});

test('disk-backed PostgreSQL restart preserves decisions and safe rollback retains the journal',async()=>{
  const directory=mkdtempSync(new URL('./.postgres-restart-',import.meta.url));
  let db;
  try {
    db=new PGlite(directory);await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
    await db.exec('update public.hd1_coordinator set paused=false,epoch=10;');
    await rpc(db,'admit',claim('a',120));await db.close();
    db=new PGlite(directory);
    assert.equal((await rpc(db,'admit',claim('a',120))).state,'queued');
    assert.equal((await rpc(db,'read')).claims.length,1);
    await db.exec(readFileSync(new URL('../supabase/001_leaderboard.rollback.sql',import.meta.url),'utf8'));
    assert.equal((await db.query('select count(*)::integer as count from public.hd1_claims')).rows[0].count,1);
    await db.exec('set role service_role');await assert.rejects(rpc(db,'read'),/permission denied/);
  }finally{if(db)await db.close();rmSync(directory,{recursive:true,force:true});}
});

test('SQL grants deny browser and direct service table writes; RPC rate bound is durable',async()=>{
  const db=await database();
  try {
    await db.exec('set role anon;');
    await assert.rejects(rpc(db,'read'),/permission denied/);
    await db.exec('reset role;set role service_role;');
    await assert.rejects(db.query('select * from public.hd1_claims'),/permission denied/);
    await db.exec("reset role;insert into public.hd1_rates values('expired-ip',clock_timestamp()-interval '11 minutes',10),('recent-ip',clock_timestamp()-interval '2 minutes',10);set role service_role;");
    for(let i=0;i<10;i++)assert.equal((await rpc(db,'rate',{bucket:'fixture'})).code,'ok');
    assert.equal((await rpc(db,'rate',{bucket:'fixture'})).code,'rate_limited');
    await db.exec('reset role;');
    const buckets=(await db.query('select bucket from public.hd1_rates')).rows.map(row=>row.bucket);
    assert(!buckets.includes('expired-ip'));assert(buckets.includes('recent-ip'));
    await db.exec("update public.hd1_rates set started=clock_timestamp()-interval '61 seconds' where bucket='fixture';");
    assert.equal((await rpc(db,'rate',{bucket:'fixture'})).code,'ok');
    assert.equal((await db.query("select count from public.hd1_rates where bucket='fixture'")).rows[0].count,1);
  }finally{await db.close();}
});
