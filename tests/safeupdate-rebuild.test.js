import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
const correctionName='005_safeupdate_rebuild.sql';
const sql=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const correction=sql(correctionName);

/** Extract the single preserved function for exact, not approximate, migration parity. */
function definition(source) {
  return source.slice(source.indexOf('create or replace function '),source.lastIndexOf('end $$;')+7);
}

/** Read all operational rows without exposing or depending on hosted credentials. */
async function state(db) {
  const result={};
  for(const table of ['hd1_coordinator','hd1_claims','hd1_receipts','hd1_rates','hd1_runtime'])
    result[table]=(await db.query('select * from public.'+table+' order by 1')).rows;
  return result;
}

/** Capture function identity, ownership and ACLs, plus the wrappers that must not change. */
async function functions(db) {
  return (await db.query(`select oid::text,proname,proowner::text,proacl::text,
    case when proname<>'hd1_rpc_v2' then pg_get_functiondef(oid) end as definition
    from pg_proc where pronamespace='public'::regnamespace and proname like 'hd1_%' order by proname`)).rows;
}

/** Exercise only local PostgreSQL fixtures, with a durable ambiguous signer and finite fence. */
async function fixture() {
  const db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(migrations(correctionName));
  await db.exec(`insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision,owner,generation,prepared,raw,txid,receipt)
    values(repeat('a',64),'fixture','02'||repeat('b',64),'SYNTHETIC01','rear_guard',2900,82,820,'signing_unknown',1,'fixture-owner',7,'{"operation":"register"}','00',repeat('c',64),'fixture');
    update public.hd1_coordinator set epoch=2900,active=repeat('a',64),generation=7 where singleton;
    insert into public.hd1_rates values('fixture',clock_timestamp(),1);
    update public.hd1_runtime set finite_scope='{"id":"fixture-scope","transactions":1,"reservations":{"fixture":"preserved"}}',
      bootstrap=repeat('c',64),bootstrap_claim=repeat('a',64) where singleton;
    insert into public.hd1_receipts values('old','old','old','old','rear_guard',2900,90,800,1,0,0,'old');`);
  return db;
}

/** Call the public wrapper so both the finite and job-lease layers remain in the test path. */
async function rpc(db,operation,payload={}) {
  return (await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
}

test('safe-update rebuild correction changes only the preserved function name and explicit deletion predicate',()=>{
  const original=definition(sql('002_d6_included_successor.sql'));
  assert.equal(definition(correction),original.replace('public.hd1_rpc(','public.hd1_rpc_v2(')
    .replace('delete from public.hd1_receipts;','delete from public.hd1_receipts where true;'));
  assert.match(correction,/\nbegin;\ncreate or replace function/);
  assert.match(correction,/end \$\$;\ncommit;\n$/);
  assert.doesNotMatch(correction,/safeupdate\.enabled|truncate|drop\s|alter\s|grant\s|revoke\s/i);
  // Structural guard for the hosted protection's missing-WHERE failure; not an extension emulation.
  for(const statement of definition(correction).match(/delete\s+from\s+[^;]+;/gi)??[])
    assert.match(statement,/\bwhere\b/i);
});

test('005 upgrade preserves every operational row, function identity, owner, ACL and newer wrapper',async()=>{
  const db=await fixture();
  try {
    const before=await state(db),acl=await functions(db);
    await db.exec(correction);
    assert.deepEqual(await state(db),before);
    assert.deepEqual(await functions(db),acl);
    await db.exec('set role service_role;');
    await assert.rejects(db.query("select public.hd1_rpc_v2('read','{}')"),/permission denied/);
    assert.deepEqual((await rpc(db,'operational')).finite_scope,before.hd1_runtime[0].finite_scope);
    assert.equal((await rpc(db,'job',{owner:'ordinary-cron'})).code,'finite_scope_required');
    await db.exec('reset role;set role anon;');
    await assert.rejects(rpc(db,'read'),/permission denied/);
  } finally {await db.close();}
});

test('corrected synchronization replaces only the derived index and rolls back an invalid replacement atomically',async()=>{
  const db=await fixture();
  try {
    await db.exec(correction);
    const original=await state(db);
    await db.exec('set role service_role;');
    const runtime=await rpc(db,'job',{owner:'fixture-job',scope:'fixture-scope'});
    const coordinator=(await rpc(db,'read')).coordinator;
    const receipt={id:'new',txid:'new',player:'new',nickname:'new',layout:'rear_guard',epoch:2900,moves:82,points:820,
      height:90,transaction_index:0,output_index:0,receipt:'new'};
    const payload={job:'fixture-job',version:runtime.version,revision:coordinator.revision,epoch:2900,head:null,
      snapshot:{hash:'fixture-hash',height:100,stale:false,receipts:[receipt],pending:[],lineage:[]}};
    const beforeFailure=await rpc(db,'read'),runtimeBefore=await rpc(db,'operational');
    await assert.rejects(rpc(db,'synchronize',{...payload,snapshot:{...payload.snapshot,receipts:[{...receipt,id:null}]}}),/null value/);
    assert.deepEqual(await rpc(db,'read'),beforeFailure);
    assert.deepEqual(await rpc(db,'operational'),runtimeBefore);
    await db.exec('reset role;');
    assert.deepEqual((await state(db)).hd1_receipts,original.hd1_receipts);
    await db.exec('set role service_role;');
    const synchronized=await rpc(db,'synchronize',payload);
    assert.equal(synchronized.ready,true);assert.equal(synchronized.code,'ready');
    const afterRead=await rpc(db,'read');
    assert.equal(afterRead.coordinator.generation,7);assert.equal(afterRead.coordinator.active,'a'.repeat(64));
    assert.deepEqual(afterRead.claims,original.hd1_claims);
    assert.equal((await rpc(db,'prepare',{id:'a'.repeat(64)})).code,'finite_scope_required');
    const readiness=(await db.query("select public.hd1_public('readiness','{}') as value")).rows[0].value;
    assert.equal(readiness.capability_revision,4);assert.equal(readiness.available,true);
    await db.exec('reset role;');
    const after=await state(db);
    assert.deepEqual(after.hd1_receipts,[receipt]);
    assert.deepEqual(after.hd1_claims,original.hd1_claims);assert.deepEqual(after.hd1_rates,original.hd1_rates);
    for(const field of ['finite_scope','bootstrap','bootstrap_claim'])
      assert.deepEqual(after.hd1_runtime[0][field],original.hd1_runtime[0][field]);
  } finally {await db.close();}
});
