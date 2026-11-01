import test from 'node:test';
import assert from 'node:assert/strict';
import { failedFixture } from './recovery-fixture.js';
import { databaseFixture } from './publisher-fixture.js';
import { parseTransaction,estimatedSignedBytes } from '../leaderboard/chain.js';
import { liveAcceptance } from './live-publisher-acceptance.js';

/** Observe a changed node policy without touching any hosted service. */
function setFloor(chain,value) {
  const route=chain.route;
  chain.route=(path,init)=>path==='/mempool'?{minrelaytxfee:value,mempoolminfee:value}:route(path,init);
}

test('independent recovery at 100 units funds signed bytes and floor drift preserves the exact outbox',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.invalidate();setFloor(f.chain,0.001);
    assert.equal((await f.tick()).code,'broadcast_pending');
    const before=await f.storage.rpc('recovery_inspect'),tx=parseTransaction(before.attempt.raw);
    assert.equal(before.attempt.prepared.relayFloor,100);
    assert(before.fee_units>=before.attempt.raw.length/2*100,'actual signed bytes must meet observed relay floor');
    assert(before.fee_units>=estimatedSignedBytes(tx)*100,'maximum signed shape must be funded');
    assert(before.fee_units<=100000,'absolute fee authority remains bounded');
    f.chain.mempool=[];
    await f.db.exec("update public.hd1_recovery set attempt=jsonb_set(attempt,'{retry_at}',to_jsonb((clock_timestamp()-interval '1 second')::text));");
    const persisted=await f.storage.rpc('recovery_inspect');
    setFloor(f.chain,0.00101);
    assert.equal((await f.tick()).code,'relay_fee_policy_incompatible');
    const after=await f.storage.rpc('recovery_inspect');
    assert.deepEqual(after.attempt,persisted.attempt,'incompatible floor cannot rewrite or re-sign persisted bytes');
    for(const key of ['transactions','broadcasts','fee_units','new_locked_units'])assert.equal(after[key],before[key],key);
    assert.equal(f.chain.broadcasts.length,1,'floor rejection must precede consuming another broadcast');
  }finally {await f.db.close();}
});

test('independent fresh migration ACL denies all recovery access to public roles and keeps service inspection read-only',async()=>{
  const {db,storage}=await databaseFixture();
  try {
    for(const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      for(const sql of ["select public.hd1_rpc('recovery_inspect','{}')","select public.hd1_recovery_read('inspect','{}')",
        "select public.hd1_rpc_v6('read','{}')","select public.hd1_public_v6('readiness','{}')",'select * from public.hd1_recovery'])
        await assert.rejects(db.query(sql),/permission denied/,role+' must not access '+sql);
      await db.exec('reset role');
    }
    await db.exec('set role service_role;begin read only;');
    assert.equal(await storage.recoveryRead(),null);
    assert.equal((await storage.publicRead('readiness')).recovery_capability_revision,7);
    await db.exec('rollback;reset role;');
  }finally {await db.close();}
});

test('independent malformed recovery grammar rejects before any transport side effect',async()=>{
  let calls=0;
  const fetch=async()=>{calls++;throw Error('unexpected_transport');};
  for(const args of [['--inspect-recovery','--inspect-recovery'],['--inspect-recovery=true'],
    ['--resume-recovery=bad'],['--inspect-recovery','--raw-txid=aa','--ticks=1'],
    ['--resume-recovery=00000000-0000-0000-0000-000000000000','--ticks=1e0'],
    ['--install-recovery','--publish']])
    await assert.rejects(liveAcceptance({},args,{fetch}),/invalid_recovery_arguments/);
  assert.equal(calls,0,'invalid grammar cannot read storage, sign or broadcast');
});
