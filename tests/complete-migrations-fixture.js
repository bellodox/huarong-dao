// Test-only installation of ALL 14 unmodified migrations, in numeric order.
// Migration 013 is an operational, already-authorized scope extension, not a
// fresh-install DDL migration. Reproduce its exact preconditions in disposable
// PGlite before applying the original SQL. The database is disposable, and
// the 013 operational outcome remains intact for the integration test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from './schema.js';

const MIGRATION_013 = '013_extend_continuing_beta_allowance.sql';
const MIGRATION_014 = '014_restore_publisher_rpc_execute.sql';
const AUTHORITY = '48262ae3-4488-447c-950d-c5da7dcb9025';
const FAKE_CLAIM = '0'.repeat(64);
const FAKE_RECOVERY = '00000000-0000-4000-8000-000000000013';
const directory = new URL('../supabase/migrations/', import.meta.url);

async function prepareOperationalScope(db) {
  const existing = (await db.query(
    'select version,finite_scope,owner from public.hd1_runtime where singleton'
  )).rows[0];
  assert.ok(existing, 'migration 003 must create a runtime row');
  assert.equal(existing.finite_scope, null, 'fresh test database must have no operational scope');
  assert.equal(existing.owner, null, 'fresh test database must have no active publisher');
  assert.equal((await db.query('select count(*)::integer as n from public.hd1_recovery')).rows[0].n, 0);

  // Only a fixture: no signing, RPC invocation, transaction broadcasting, or
  // production credentials. The claim is rejected and cannot enter rankings.
  await db.query(`insert into public.hd1_claims
    (id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
    values ($1,'{}',$2,'MIGRATIONTEST','wings',0,116,0,'rejected',0)`,
    [FAKE_CLAIM, '02'+'0'.repeat(64)]);
  await db.query(`insert into public.hd1_recovery
    (id,original_id,envelope,attempt,status,completion)
    values ($1,$2,'{}'::jsonb,'{}'::jsonb,'completed',
      jsonb_build_object('authority_id',$3::text))`,
    [FAKE_RECOVERY, FAKE_CLAIM, AUTHORITY]);
  await db.query(`update public.hd1_runtime set finite_scope=jsonb_build_object(
    'id',$1::text,'mode','continuing_beta','name','g/huarong-lb',
    'max_transactions',10,'max_broadcasts',40,
    'max_fee_units',1000000,'max_new_locked_units',6000,
    'transactions',0,'broadcasts',0,'fee_units',0,'new_locked_units',0,
    'claims','[]'::jsonb,'reservations','{}'::jsonb
  ) where singleton`, [AUTHORITY]);
  return existing.version;
}

async function verifyOperationalScope(db,originalVersion) {
  // Exercise the real 013 operational effect without reversing it.
  const state=(await db.query('select version,finite_scope from public.hd1_runtime where singleton')).rows[0];
  assert.equal(state.finite_scope.id,AUTHORITY);
  assert.equal(state.finite_scope.mode,'continuing_beta');
  assert.equal(state.finite_scope.max_transactions,1000);
  assert.equal(state.finite_scope.max_broadcasts,4000);
  assert.equal(state.finite_scope.max_fee_units,100000000);
  assert.equal(state.finite_scope.max_new_locked_units,600000);
  assert.equal(Number(state.version),Number(originalVersion)+1);

  // Exercise the real 014 ACL effect, including its public-role restrictions.
  const access=(await db.query(`select
    has_schema_privilege('service_role','public','USAGE') as schema_usage,
    has_function_privilege('service_role','public.hd1_rpc(text,jsonb)','EXECUTE') as service_execute,
    has_function_privilege('anon','public.hd1_rpc(text,jsonb)','EXECUTE') as anon_execute,
    has_function_privilege('authenticated','public.hd1_rpc(text,jsonb)','EXECUTE') as authenticated_execute`
  )).rows[0];
  assert.equal(access.schema_usage,true);
  assert.equal(access.service_execute,true);
  assert.equal(access.anon_execute,false);
  assert.equal(access.authenticated_execute,false);

  // The artificial predecessor is rejected and cannot contribute a public
  // result. The full continuing-beta authority and recovery remain installed
  // until the disposable test database itself is closed.
  const predecessor=(await db.query('select state from public.hd1_claims where id=$1',[FAKE_CLAIM])).rows[0];
  assert.equal(predecessor.state,'rejected');
  assert.equal((await db.query('select count(*)::integer as n from public.hd1_receipts')).rows[0].n,0);
}

export async function applyCompleteMigrations(db) {
  const expected=Array.from({length:14},(_,i)=>String(i+1).padStart(3,'0'));
  assert.deepEqual(MIGRATIONS.map(name=>name.slice(0,3)),expected,
    'review the full-migration fixture if the migration set changes');
  assert.equal(MIGRATIONS[12],MIGRATION_013);
  assert.equal(MIGRATIONS[13],MIGRATION_014);
  let originalVersion=null;
  for(const name of MIGRATIONS) {
    if(name===MIGRATION_013)originalVersion=await prepareOperationalScope(db);
    await db.exec(readFileSync(new URL(name,directory),'utf8'));
  }
  await verifyOperationalScope(db,originalVersion);
}
