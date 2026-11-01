import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runPublisher } from '../leaderboard/publisher.js';
import { config,connectDatabase,bindings } from './publisher-fixture.js';
import { failedFixture } from './recovery-fixture.js';
import { liveAcceptance } from './live-publisher-acceptance.js';
import { createSpaceXpanseProvider,headerHash } from '../leaderboard/provider.js';
import { authenticateRetirement } from '../leaderboard/recovery.js';
import { recoveryStorage } from '../leaderboard/storage.js';

test('failed fee freezes original; confirmed conflict permits one fresh persisted attempt and one/six-confirmation reconstruction',async()=>{
  const f=await failedFixture();
  try {
    const originalScope=(await f.storage.rpc('operational')).finite_scope;
    assert.equal(originalScope.transactions,1);assert.equal(originalScope.broadcasts,1);
    assert.equal((await f.install()).status,'recovery_frozen');
    assert.equal((await runPublisher(f.storage,config,{fetch:f.chain.fetch,scope:f.scope.id})).code,'recovery_required');
    assert.equal((await f.tick()).code,'recovery_frozen');
    assert.deepEqual((await f.storage.read()).claims[0],f.original);
    f.invalidate();
    const result=await f.tick();assert.equal(result.code,'broadcast_pending',JSON.stringify(result));
    let journal=await f.storage.rpc('recovery_inspect');
    assert.equal(journal.transactions,1);assert.equal(journal.broadcasts,1);assert(journal.attempt.raw);
    assert.equal(journal.attempt.prepared.fee>f.original.prepared.fee,true);
    assert.deepEqual(f.chain.broadcasts,[journal.attempt.raw]);
    assert.equal((await f.storage.rpc('operational')).bootstrap,f.original.txid);
    assert.equal(journal.effective_bootstrap,journal.attempt.txid);
    f.chain.mine([journal.attempt.raw]);
    assert.equal((await f.tick()).code,'included');
    assert.equal((await f.storage.rpc('recovery_inspect')).attempt.confirmations,1);
    assert.equal((await f.storage.read()).coordinator.snapshot.pending.length,1);
    for(let i=0;i<5;i++)f.chain.mine();assert.equal((await f.tick()).code,'confirmed');
    journal=await f.storage.rpc('recovery_inspect');
    assert.equal(journal.attempt.confirmations,6);assert.equal(f.chain.broadcasts.length,1);
    assert.equal((await f.storage.read()).coordinator.snapshot.receipts.length,1);
    assert.equal((await f.storage.publicRead('leaderboard')).rows.length,1);
    assert.equal((await f.storage.publicRead('status',{id:f.original.id})).recovery_status,'confirmed');
    const original=(await f.storage.read()).claims[0];
    for(const key of ['raw','txid','prepared','receipt','generation','owner','attempts'])assert.deepEqual(original[key],f.original[key]);
    assert.deepEqual((await f.storage.rpc('operational')).finite_scope,originalScope);
  }finally {await f.db.close();}
});
test('migration upgrade preserves original journal/bootstrap/scope, read-only capability and service-only ACLs',async()=>{
  const f=await failedFixture(undefined,{upgrade:true});
  try {
    const migration=readFileSync(new URL('../supabase/migrations/007_failed_transaction_recovery.sql',import.meta.url),'utf8');
    const before=await f.storage.read(),runtime=await f.storage.rpc('operational');
    assert.equal((await f.tick()).code,'recovery_schema_upgrade_required');
    await f.db.exec(migration);
    assert.deepEqual(await f.storage.read(),before);assert.deepEqual(await f.storage.rpc('operational'),runtime);
    await f.db.exec('set role service_role;begin read only;');
    assert.equal((await f.storage.publicRead('readiness')).recovery_capability_revision,7);
    assert.equal(await f.storage.recoveryRead(),null);
    assert.equal((await f.storage.recoveryRead('raw',{txid:f.original.txid})).raw,f.original.raw);
    await f.db.exec('rollback;set role service_role;');
    await assert.rejects(f.db.query('select * from public.hd1_recovery'),/permission denied/);
    await assert.rejects(f.db.query("select public.hd1_rpc_v6('read','{}')"),/permission denied/);
    await f.db.exec('set role anon;');await assert.rejects(f.install(),/permission denied/);
    await f.db.exec('reset role;');
    const installed=await f.install();assert.equal(installed.status,'recovery_frozen');
    assert.deepEqual(await f.install(),installed);
    assert.equal((await f.storage.rpc('recovery_install',{...f.envelope,max_fee_units:99999})).code,'recovery_exists');
    assert.equal((await f.storage.rpc('recovery_begin',{recovery:'wrong'})).code,'recovery_mismatch');
    assert.deepEqual((await f.storage.read()).claims[0],f.original);
  }finally {await f.db.close();}
});

test('operator inspect/export is read-only, install never signs, strict resume matches only immutable recovery ID',async()=>{
  const f=await failedFixture(),operations=[];
  const fetcher=async(url,init)=>{
    if(String(url).startsWith(bindings.SUPABASE_URL)) {
      const {operation,payload}=JSON.parse(init.body);operations.push(operation);
      return Response.json(await(String(url).endsWith('hd1_public')?f.storage.publicRead(operation,payload):
        String(url).endsWith('hd1_recovery_read')?f.storage.recoveryRead(operation,payload):f.storage.rpc(operation,payload)));
    }
    return f.chain.fetch(url,init);
  };
  try {
    const state=await f.storage.read(),runtime=await f.storage.rpc('operational');
    const inspected=await liveAcceptance(bindings,['--inspect-recovery','--raw-txid='+f.original.txid],{fetch:fetcher});
    assert.equal(inspected.raw,f.original.raw);assert(operations.every(op=>['readiness','inspect','raw'].includes(op)));
    assert.equal(inspected.receipt_id,f.original.id);assert.equal(inspected.generation,f.original.generation);assert.equal(inspected.scope_id,f.scope.id);
    assert.deepEqual(await f.storage.read(),state);assert.deepEqual(await f.storage.rpc('operational'),runtime);
    for(const args of [['--inspect-recovery','--ticks=1'],['--resume-recovery='+f.envelope.id,'--max-fee-units=1'],
      ['--resume-recovery='+f.envelope.id,'--ticks=01'],['--inspect-recovery','--publish'],['--install-recovery']])
      await assert.rejects(liveAcceptance(bindings,args,{fetch:fetcher}),/invalid_recovery_arguments/);
    const e=f.envelope,args=['--install-recovery','--recovery-id='+e.id,'--original-scope='+e.scope_id,'--claim-id='+e.claim_id,
      '--original-txid='+e.original_txid,'--generation='+e.generation,'--conflict-txid='+e.conflict_txid,'--consent-claim='+e.consent_claim,
      '--name='+e.name,'--max-broadcasts='+e.max_broadcasts,'--max-fee-units='+e.max_fee_units,'--max-new-locked-units='+e.max_new_locked_units];
    const installed=await liveAcceptance(bindings,args,{fetch:fetcher});assert.equal(installed.ok,true);assert.equal(installed.broadcasts,0);
    assert.equal(f.chain.broadcasts.length,0);
    assert.equal((await liveAcceptance(bindings,['--resume-recovery='+crypto.randomUUID()],{fetch:fetcher})).code,'recovery_mismatch');
    f.invalidate();
    const resumed=await liveAcceptance(bindings,['--resume-recovery='+e.id,'--ticks=1'],{fetch:fetcher});
    assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.equal(resumed.broadcasts_sent,1);
    assert(!JSON.stringify(resumed).includes(bindings.ROD_APP_WIF));assert(!JSON.stringify(resumed).includes(f.original.raw));
  }finally {await f.db.close();}
});

test('lost begin is never signed again after durable database restart or lease expiry',async()=>{
  const directory=mkdtempSync(new URL('./.recovery-begin-',import.meta.url)),f=await failedFixture(directory);let db=f.db,storage=f.storage;
  try {
    await f.install();f.invalidate();
    const lossy={...storage,rpc:async(op,payload)=>{const value=await storage.rpc(op,payload);if(op==='recovery_begin')throw Error('lost_begin');return value;}};
    await runPublisher(lossy,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id});
    const saved=await storage.rpc('recovery_inspect');assert.equal(saved.transactions,1);assert.equal(saved.attempt.state,'signing_started');
    assert.equal(saved.attempt.raw,null);assert.equal(f.chain.broadcasts.length,0);
    await db.close();db=new PGlite(directory);storage=connectDatabase(db);
    await db.exec("update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    assert.equal((await runPublisher(storage,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id})).code,'signing_unknown');
    const after=await storage.rpc('recovery_inspect');assert.equal(after.transactions,1);assert.deepEqual(after.attempt,saved.attempt);
    assert.equal((await storage.read()).coordinator.generation,2);assert.equal(f.chain.broadcasts.length,0);
  }finally {await db.close();rmSync(directory,{recursive:true,force:true});}
});

test('lost finalize recovers exact persisted bytes after restart with one signer and finite retry exhaustion',async()=>{
  const directory=mkdtempSync(new URL('./.recovery-finalize-',import.meta.url)),f=await failedFixture(directory);let db=f.db,storage=f.storage;
  try {
    await f.install();f.invalidate();
    const lossy={...storage,rpc:async(op,payload)=>{const value=await storage.rpc(op,payload);if(op==='recovery_finalize')throw Error('lost_finalize');return value;}};
    await runPublisher(lossy,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id});
    const saved=await storage.rpc('recovery_inspect');assert.equal(saved.attempt.state,'signed_persisted');assert(saved.attempt.raw);
    assert.equal(f.chain.broadcasts.length,0);
    await db.close();db=new PGlite(directory);storage=connectDatabase(db);
    f.chain.hooks.any=path=>path==='/broadcast'?Response.json({error:{code:-26,message:'min relay fee not met'},result:null}):null;
    const attempts=[];const fetcher=async(url,init)=>{if(url.endsWith('/broadcast'))attempts.push(new URLSearchParams(init.body).get('raw'));return f.chain.fetch(url,init);};
    const tick=()=>runPublisher(storage,config,{fetch:fetcher,scope:f.scope.id,recovery:f.envelope.id});
    assert.equal((await tick()).code,'broadcast_unknown');
    await db.exec("update public.hd1_recovery set attempt=jsonb_set(attempt,'{retry_at}',to_jsonb((clock_timestamp()-interval '1 second')::text));");
    assert.equal((await tick()).code,'broadcast_unknown');
    assert.equal((await tick()).code,'broadcast_budget_exhausted');
    const after=await storage.rpc('recovery_inspect');assert.equal(after.transactions,1);assert.equal(after.broadcasts,2);
    assert.equal(after.fee_units,saved.fee_units);assert.equal(after.new_locked_units,saved.new_locked_units);
    assert.deepEqual(attempts,[saved.attempt.raw,saved.attempt.raw]);assert.equal((await storage.read()).coordinator.generation,2);
    assert.equal((await storage.rpc('recovery_finalize',{recovery:f.envelope.id,scope:f.scope.id,job:'expired',id:f.original.id})).code,'stale_job');
  }finally {await db.close();rmSync(directory,{recursive:true,force:true});}
});

test('proof reorg after retirement pauses exact-byte retry without new signatures or broadcasts',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.invalidate();assert.equal((await f.tick()).code,'broadcast_pending');
    const saved=await f.storage.rpc('recovery_inspect');
    f.chain.mempool=[];f.chain.txs.delete(f.conflict.txid);
    assert.equal((await f.tick()).code,'recovery_proof_reorg');
    const after=await f.storage.rpc('recovery_inspect');assert.equal(after.status,'recovery_proof_reorg');
    assert.equal(after.checked_hash,null);assert.deepEqual(after.attempt,saved.attempt);
    assert.equal((await f.storage.read()).coordinator.paused,true);assert.equal(f.chain.broadcasts.length,1);
    assert.equal((await f.storage.publicRead('readiness')).available,false);
  }finally {await f.db.close();}
});

test('insufficient fresh bounds, changed week and stale consent association reject before recovery signer',async()=>{
  for(const kind of ['fee','locked','week','consent','generation','scope']) {
    const f=await failedFixture();
    try {
      if(kind==='fee')f.envelope.max_fee_units=1;
      if(kind==='locked')f.envelope.max_new_locked_units=0;
      if(kind==='consent')f.envelope.consent_claim='ab'.repeat(32);
      if(kind==='generation')f.envelope.generation++;
      if(kind==='scope')f.envelope.scope_id=crypto.randomUUID();
      const install=await f.install();
      if(['consent','generation','scope'].includes(kind)){assert.equal(install.code,'invalid_recovery');continue;}
      f.invalidate();
      if(kind==='week')for(let i=0;i<11;i++){f.chain.mine();f.chain.blocks.at(-1).time+=604800;f.chain.blocks.at(-1).hash=headerHash(f.chain.blocks.at(-1));}
      assert.equal((await f.tick()).code,kind==='week'?'epoch_changed':'spend_budget_exhausted');
      const saved=await f.storage.rpc('recovery_inspect');assert.equal(saved.transactions,0);assert.equal(saved.attempt.raw,null);
      assert.equal(f.chain.broadcasts.length,0);
    }finally {await f.db.close();}
  }
});

test('original canonical inclusion is reconciled normally and never replaced',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.chain.mine([f.original.raw]);f.chain.hooks.any=null;
    assert.equal((await f.tick()).code,'original_included');
    assert.equal((await f.storage.read()).claims[0].state,'included');
    assert.equal((await f.storage.rpc('recovery_inspect')).transactions,0);assert.equal(f.chain.broadcasts.length,0);
    for(let i=0;i<5;i++)f.chain.mine();await f.tick();
    assert.equal((await f.storage.read()).claims[0].state,'confirmed');
    assert.equal((await f.storage.publicRead('leaderboard')).rows.length,1);
  }finally {await f.db.close();}
});

test('replacement update spends the current authenticated name head and preserves historical bootstrap',async()=>{
  const f=await failedFixture(undefined,{update:true});
  try {
    const before=await f.storage.rpc('operational'),head=(await f.storage.read()).coordinator.head;
    assert.equal(f.original.prepared.operation,'update');
    await f.install();f.invalidate();
    assert.equal((await f.tick()).code,'broadcast_pending');
    const saved=await f.storage.rpc('recovery_inspect');
    assert.equal(saved.attempt.prepared.operation,'update');assert.equal(saved.new_locked_units,600);
    assert(saved.attempt.prepared.inputs.some(input=>input.txid+':'+input.index===head));
    assert.equal(saved.effective_bootstrap,null);assert.equal((await f.storage.rpc('operational')).bootstrap,before.bootstrap);
    f.chain.mine([saved.attempt.raw]);assert.equal((await f.tick()).code,'included');
    for(let i=0;i<5;i++)f.chain.mine();assert.equal((await f.tick()).code,'confirmed');
    assert.equal((await f.storage.read()).coordinator.snapshot.receipts.length,2);
  }finally {await f.db.close();}
});

test('overlapping recovery jobs, original mutation fences and idempotent immutable finalize',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.invalidate();
    const results=await Promise.all([f.tick(),f.tick()]);assert(results.some(row=>row.code==='job_busy'));
    const saved=await f.storage.rpc('recovery_inspect'),a=saved.attempt;
    assert.equal(saved.transactions,1);assert.equal(saved.broadcasts,1);assert.equal(f.chain.broadcasts.length,1);
    for(const operation of ['prepare','begin','broadcast','cancel'])assert.equal((await f.storage.rpc(operation,
      {scope:f.scope.id,id:f.original.id,owner:f.original.owner,generation:f.original.generation})).code,'recovery_required');
    const job='finalize-readback';await f.storage.rpc('job',{owner:job,scope:f.scope.id,recovery:f.envelope.id});
    const adapter=recoveryStorage(f.storage,f.envelope.id,f.scope.id,job),payload={id:a.id,owner:a.owner,generation:a.generation,
      raw:a.raw,txid:a.txid,receipt:a.receipt};
    assert.deepEqual(await adapter.rpc('finalize',payload),a);
    assert.equal((await adapter.rpc('finalize',{...payload,raw:f.original.raw})).code,'idempotency_conflict');
    assert.equal((await adapter.rpc('finalize',{...payload,generation:a.generation+1})).code,'stale_owner');
    assert.deepEqual((await f.storage.rpc('recovery_inspect')).attempt,a);
    await f.storage.rpc('job_done',{job});
  }finally {await f.db.close();}
});

test('SQL proof revision/shared-input checks and begin eligibility recheck cannot release another barrier',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.invalidate();
    // Stop before signing, with a legitimate acquired snapshot and positive retirement proof.
    const intercepted={...f.storage,rpc:async(op,payload)=>op==='recovery_prepare'?{code:'stale_state'}:f.storage.rpc(op,payload)};
    await runPublisher(intercepted,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id});
    const job='manual-check',runtime=await f.storage.rpc('job',{owner:job,scope:f.scope.id,recovery:f.envelope.id}),state=await f.storage.read();
    const provider=createSpaceXpanseProvider({...config,anchor:runtime.config.anchor,fetch:f.chain.fetch,allowUnprovenNameAbsence:true});
    const journal=await f.storage.rpc('recovery_inspect'),proof=await authenticateRetirement(provider.primitives,f.original,f.conflict.txid,config,runtime.document,journal.proof);
    const base={job,scope:f.scope.id,recovery:f.envelope.id,recovery_revision:journal.revision,proof:proof.proof,confirmations:proof.confirmations,tip_hash:proof.tip.hash};
    assert.equal((await f.storage.rpc('recovery_prove',{...base,recovery_revision:journal.revision-1})).code,'stale_state');
    assert.equal((await f.storage.rpc('recovery_prove',{...base,proof:{...proof.proof,input:{txid:'ab'.repeat(32),index:0}}})).code,'invalid_retirement_proof');
    const observation=await provider.prepare(journal.attempt),adapter=recoveryStorage(f.storage,f.envelope.id,f.scope.id,job);
    const lease=await adapter.rpc('prepare',{id:f.original.id,owner:'signer',revision:state.coordinator.revision,
      epoch:observation.epoch,head:observation.head,prepared:observation.prepared});assert.equal(lease.state,'unsigned_preparing');
    // A new independent canonical score at this boundary makes the old consent non-improving.
    await f.db.query('insert into public.hd1_receipts values($1,$2,$3,$4,$5,$6,$7,$8,100,0,0,$9)',
      ['ab'.repeat(32),'cd'.repeat(32),f.original.player,f.original.nickname,f.original.layout,f.original.epoch,1,1,'fixture-derived-row']);
    const begin=await adapter.rpc('begin',{id:f.original.id,owner:'signer',generation:lease.generation,revision:lease.evaluation_revision,
      epoch:observation.epoch,head:observation.head,prepared:observation.prepared});assert.equal(begin.code,'not_improved');
    assert.equal((await f.storage.rpc('recovery_inspect')).transactions,0);
    await f.storage.rpc('job_done',{job});
  }finally {await f.db.close();}
});

test('mempool replacement remains pending and no exact retry is consumed or original broadcast resurrected',async()=>{
  const f=await failedFixture();
  try {
    await f.install();f.invalidate();await f.tick();
    const saved=await f.storage.rpc('recovery_inspect');
    assert.equal((await f.tick()).code,'broadcast_unknown');
    assert.equal((await f.storage.rpc('recovery_inspect')).broadcasts,saved.broadcasts);
    assert.equal(f.chain.broadcasts.length,1);
    assert.equal((await runPublisher(f.storage,config,{fetch:f.chain.fetch})).code,'recovery_required');
  }finally {await f.db.close();}
});

test('bundled relay executes the same recovery issuer and independently reconstructs effective bootstrap',async()=>{
  const f=await failedFixture();
  try {
    const relay=await import('../relay.js');
    assert.equal((await relay.installRecovery(f.storage,config,f.envelope)).ok,true);f.invalidate();
    const result=await relay.runPublisher(f.storage,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id});
    assert.equal(result.code,'broadcast_pending');
    const saved=await f.storage.rpc('recovery_inspect');f.chain.mine([saved.attempt.raw]);
    assert.equal((await relay.runPublisher(f.storage,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id})).code,'included');
    assert.equal((await f.storage.read()).coordinator.active,null);
    for(let i=0;i<5;i++)f.chain.mine();
    assert.equal((await relay.runPublisher(f.storage,config,{fetch:f.chain.fetch,scope:f.scope.id,recovery:f.envelope.id})).code,'confirmed');
    const provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:f.chain.blocks[0].hash},bootstrap:{txid:saved.effective_bootstrap},fetch:f.chain.fetch});
    const history=await provider.history(),snapshot=relay.reconstruct(history);
    assert.equal(snapshot.receipts.length,1);assert.equal(snapshot.receipts[0].txid,saved.attempt.txid);
    assert.equal(snapshot.receipts[0].id,f.original.id);assert(!snapshot.lineage.some(row=>row.txid===f.original.txid));
    assert.deepEqual(snapshot.receipts,(await f.storage.read()).coordinator.snapshot.receipts);
  }finally {await f.db.close();}
});
