import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveAcceptance } from './live-publisher-acceptance.js';
import { bindings,config,chainFixture,databaseFixture,connectDatabase } from './publisher-fixture.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { canonical,receiptId,signPlayer } from '../leaderboard/receipt.js';
import { admit } from '../leaderboard/issuer.js';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';

const publicationArgs=['--publish','--name=g/huarong-lb','--max-broadcasts=1','--max-fee-units=100000','--max-new-locked-units=1000600','--ticks=2'];
/** Route only public non-funded fixture requests; no hosted operations. */
function acceptanceFetch(storage,chain) {
  return async(url,init)=>{
    if(String(url).startsWith(bindings.SUPABASE_URL)) {
      const {operation,payload}=JSON.parse(init.body);
      return Response.json(await(String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
    }
    return chain.fetch(url,init);
  };
}
/** Queue one existing consented fixture claim after local readiness. */
async function queueClaim(storage,chain) {
  await runPublisher(storage,config,{fetch:chain.fetch});
  const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
  await admit(storage,verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)));
}
/** Open one immutable scope over currently queued claims. */
function openScope(storage,limits={}) {
  return storage.rpc('finite_open',{id:crypto.randomUUID(),name:'g/huarong-lb',max_transactions:2,
    max_fee_units:100000,max_new_locked_units:1000600,...limits});
}
/** Add another independently consented player before taking the scope snapshot. */
async function queueOther(storage,key=4) {
  const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
  const {s,...unsigned}=playerClaim,other=signPlayer({...unsigned,n:'Other'+key},Uint8Array.from([...Array(31).fill(0),key]));
  const verified=verifyClaim(canonical(other,7),receiptId(other));
  await admit(storage,verified);return verified.id;
}
test('hosted acceptance utility: injected bindings only, read-only default and explicit finite broadcast/fee/lock envelope',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture(),operations=[];
  const fetcher=async(url,init)=>{
    if(String(url).startsWith(bindings.SUPABASE_URL)) {
      const {operation,payload}=JSON.parse(init.body);operations.push(operation);
      return Response.json(await(String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
    }
    return chain.fetch(url,init);
  };
  try {
    await assert.rejects(liveAcceptance(bindings,['--publish'],{fetch:fetcher}),/explicit_finite_budget_required/);
    await assert.rejects(liveAcceptance(bindings,['--publish=false'],{fetch:fetcher}),/invalid_scope/);
    await assert.rejects(liveAcceptance(bindings,['--publish','--name=other','--max-broadcasts=1'],{fetch:fetcher}),/explicit_finite_budget_required/);
    const readonly=await liveAcceptance(bindings,[],{fetch:fetcher});
    assert.equal(readonly.mode,'read_only');assert.equal(readonly.broadcasts,0);
    assert(operations.every(op=>op==='readiness'));assert.equal(chain.broadcasts.length,0);
    const sql=await liveAcceptance(bindings,['--check-sql'],{fetch:fetcher});
    assert.equal(sql.sql,'job_overlap_fenced');assert.equal(chain.broadcasts.length,0);
    await runPublisher(storage,config,{fetch:chain.fetch});
    const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
    await admit(storage,verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)));
    const actual=await liveAcceptance(bindings,['--publish','--name=g/huarong-lb','--max-broadcasts=1','--max-fee-units=100000','--max-new-locked-units=1000600','--ticks=2'],{fetch:fetcher});
    assert.equal(actual.broadcasts,1);assert(actual.fee_units<=100000);assert.equal(actual.new_locked_units,1000600);
    assert.equal(chain.broadcasts.length,1);assert(!JSON.stringify(actual).includes(bindings.ROD_APP_WIF));
    assert.equal(actual.ok,true);assert.equal(actual.reserved_transactions,1);
  }finally {await db.close();}
});

test('insufficient finite fee or zero lock rejects before signing, and later ordinary cron stays fenced',async()=>{
  for(const option of ['--max-fee-units=1','--max-new-locked-units=0']) {
    const {db,storage}=await databaseFixture(),chain=chainFixture();
    try {
      await queueClaim(storage,chain);
      const args=publicationArgs.map(arg=>arg.split('=')[0]===option.split('=')[0]?option:arg);
      const result=await liveAcceptance(bindings,args,{fetch:acceptanceFetch(storage,chain)});
      assert.equal(result.ok,false);assert.equal(result.code,'spend_budget_exhausted');
      assert.equal(result.reserved_transactions,0);assert.equal(result.fee_units,0);assert.equal(result.new_locked_units,0);
      const before=await storage.read(),claim=before.claims[0];
      assert.equal(claim.state,'queued');assert.equal(claim.raw,null);assert.equal(claim.attempts,0);
      assert.equal(before.coordinator.generation,0);assert.equal(chain.broadcasts.length,0);
      assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
      assert.deepEqual(await storage.read(),before);assert.equal(chain.broadcasts.length,0);
    }finally {await db.close();}
  }
});

test('rejected scope survives database restart and scheduler lease expiry without unsigned or signed mutation',async()=>{
  const directory=mkdtempSync(new URL('./.finite-restart-',import.meta.url)),chain=chainFixture();
  let {db,storage}=await databaseFixture(directory);
  try {
    await queueClaim(storage,chain);
    const result=await liveAcceptance(bindings,publicationArgs.map(arg=>arg.startsWith('--max-fee-units=')?'--max-fee-units=1':arg),
      {fetch:acceptanceFetch(storage,chain)});
    assert.equal(result.ok,false);
    const before=await storage.read(),scope=(await storage.rpc('operational')).finite_scope;
    await db.close();db=new PGlite(directory);storage=connectDatabase(db);
    await db.exec("update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    assert.equal((await openScope(storage)).code,'finite_scope_exists');
    assert.deepEqual((await storage.rpc('operational')).finite_scope,scope);
    assert.deepEqual(await storage.read(),before);assert.equal(chain.broadcasts.length,0);
  }finally {await db.close();rmSync(directory,{recursive:true,force:true});}
});

test('finite exact-raw outbox survives finalize timeout and database restart without refund or alternate signature',async()=>{
  const directory=mkdtempSync(new URL('./.finite-outbox-',import.meta.url)),chain=chainFixture();
  let {db,storage}=await databaseFixture(directory);
  try {
    await queueClaim(storage,chain);const scope=await openScope(storage,{max_transactions:1});
    const lossy={...storage,rpc:async(operation,payload)=>{
      const result=await storage.rpc(operation,payload);if(operation==='finalize')throw Error('lost_finalize');return result;
    }};
    assert.equal((await runPublisher(lossy,config,{fetch:chain.fetch,scope:scope.id})).code,'publisher_unavailable');
    const original=(await storage.read()).claims[0],saved=(await storage.rpc('operational')).finite_scope;
    assert.equal(original.state,'signed_persisted');assert(original.raw);assert.equal(chain.broadcasts.length,0);
    assert.equal(saved.transactions,1);assert.equal(saved.broadcasts,0);
    await db.close();db=new PGlite(directory);storage=connectDatabase(db);
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    assert.equal(chain.broadcasts.length,0);
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'broadcast_pending');
    assert.deepEqual(chain.broadcasts,[original.raw]);
    const state=await storage.read(),after=(await storage.rpc('operational')).finite_scope;
    assert.equal(state.claims[0].raw,original.raw);assert.equal(state.claims[0].txid,original.txid);
    assert.equal(state.claims[0].generation,original.generation);assert.equal(state.coordinator.generation,1);
    assert.equal(after.transactions,1);assert.equal(after.fee_units,saved.fee_units);assert.equal(after.new_locked_units,saved.new_locked_units);
    assert.equal(after.broadcasts,1);
  }finally {await db.close();rmSync(directory,{recursive:true,force:true});}
});

test('scope installation serializes with cron, rejects preexisting raw, and internal SQL cannot bypass the fence',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await queueClaim(storage,chain);
    const job='prior-cron';await storage.rpc('job',{owner:job});
    assert.equal((await openScope(storage)).code,'job_busy');
    assert.equal((await storage.rpc('operational')).finite_scope,null);
    await storage.rpc('job_done',{job});
    const scope=await openScope(storage);
    const results=await Promise.all([runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id}),
      runPublisher(storage,config,{fetch:chain.fetch}),runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})]);
    assert(results.some(row=>row.code==='job_busy'));assert(results.some(row=>row.code==='finite_scope_required'));
    assert.equal(chain.broadcasts.length,1);
    const row=(await storage.read()).claims[0];
    for(const operation of ['prepare','begin','broadcast'])assert.equal((await storage.rpc(operation,
      {id:row.id,owner:row.owner,generation:row.generation})).code,'finite_scope_required');
    await db.exec('set role service_role;');
    await assert.rejects(db.query("select public.hd1_rpc_v3('job','{}')"),/permission denied/);
    await assert.rejects(db.query('select finite_scope from public.hd1_runtime'),/permission denied/);
  }finally {await db.close();}
  const fixture=await databaseFixture(),otherChain=chainFixture();
  try {
    await queueClaim(fixture.storage,otherChain);
    await runPublisher(fixture.storage,config,{fetch:otherChain.fetch});
    const before=await fixture.storage.read();
    const result=await liveAcceptance(bindings,publicationArgs,{fetch:acceptanceFetch(fixture.storage,otherChain)});
    assert.equal(result.ok,false);assert.equal(result.code,'preexisting_publication');
    assert.deepEqual(await fixture.storage.read(),before);assert.equal(otherChain.broadcasts.length,1);
    assert.equal((await fixture.storage.rpc('operational')).finite_scope,null);
  }finally {await fixture.db.close();}
});

test('cumulative fee, locked value and transaction ceilings reject successor before preparation or signing',async()=>{
  for(const budget of ['fee','locked','transactions']) {
    const {db,storage}=await databaseFixture(),chain=chainFixture();
    try {
      await queueClaim(storage,chain);await runPublisher(storage,config,{fetch:chain.fetch});
      const registration=(await storage.read()).claims[0];chain.mine([registration.raw]);
      await runPublisher(storage,config,{fetch:chain.fetch});
      await queueOther(storage);await queueOther(storage,5);
      const first=(await storage.read()).claims.find(row=>row.state==='queued');
      const provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},
        bootstrap:{txid:registration.txid},fetch:chain.fetch});
      const {prepared}=await provider.prepare(first);
      const scope=await openScope(storage,{max_transactions:budget==='transactions'?1:2,
        max_fee_units:budget==='fee'?prepared.fee:100000,max_new_locked_units:budget==='locked'?600:1000600});
      assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'broadcast_pending');
      const signed=(await storage.read()).claims.find(row=>row.id===first.id);assert(signed.raw);
      const original={raw:signed.raw,txid:signed.txid,generation:signed.generation};
      chain.mine([signed.raw]);
      const result=await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id});
      assert.equal(result.code,budget==='transactions'?'transaction_budget_exhausted':'spend_budget_exhausted');
      const state=await storage.read(),rejected=state.claims.find(row=>row.id!==signed.id&&row.id!==registration.id);
      assert.equal(rejected.state,'queued');assert.equal(rejected.raw,null);assert.equal(rejected.attempts,0);
      assert.equal(state.coordinator.generation,2);assert.equal(chain.broadcasts.length,2);
      const retained=state.claims.find(row=>row.id===signed.id);
      assert.deepEqual({raw:retained.raw,txid:retained.txid,generation:retained.generation},original);
      const saved=(await storage.rpc('operational')).finite_scope;
      assert.equal(saved.transactions,1);assert.equal(saved.fee_units,prepared.fee);assert.equal(saved.new_locked_units,600);
      assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    }finally {await db.close();}
  }
});

test('multiple authorized transactions accumulate once, and later consent cannot enter the original scope',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await queueClaim(storage,chain);await runPublisher(storage,config,{fetch:chain.fetch});
    const registration=(await storage.read()).claims[0];chain.mine([registration.raw]);await runPublisher(storage,config,{fetch:chain.fetch});
    await queueOther(storage,4);await queueOther(storage,5);await queueOther(storage,6);
    const scope=await openScope(storage);
    const later=await queueOther(storage,7);
    for(let index=0;index<2;index++) {
      assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'broadcast_pending');
      const raw=chain.broadcasts.at(-1);chain.mine([raw]);
    }
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'transaction_budget_exhausted');
    const state=await storage.read(),signed=state.claims.filter(row=>row.raw&&row.id!==registration.id);
    const saved=(await storage.rpc('operational')).finite_scope;
    assert.equal(saved.transactions,2);assert.equal(saved.broadcasts,2);assert.equal(saved.new_locked_units,1200);
    assert.equal(saved.fee_units,signed.reduce((sum,row)=>sum+row.prepared.fee,0));
    assert.equal(Object.keys(saved.reservations).length,2);assert.equal(chain.broadcasts.length,3);
    const lease=await storage.rpc('job',{owner:'later',scope:scope.id});assert.equal(lease.owner,'later');
    assert.equal((await storage.rpc('prepare',{id:later,scope:scope.id,job:'later'})).code,'claim_outside_scope');
    assert.equal(state.claims.filter(row=>!row.raw).length,2);
  }finally {await db.close();}
});

test('ambiguous broadcast consumes a durable attempt, never another fee or signer, and obeys finite retry limit',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture(),attempts=[];
  try {
    await queueClaim(storage,chain);const scope=await openScope(storage,{max_transactions:2});
    chain.hooks.any=(path,init)=>{if(path==='/broadcast'){attempts.push(new URLSearchParams(init.body).get('raw'));throw Error('ambiguous_timeout');}};
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'broadcast_unknown');
    const first=(await storage.rpc('operational')).finite_scope;
    for(let index=0;index<3;index++) {
      await db.exec("update public.hd1_claims set retry_at=clock_timestamp()-interval '1 second';");
      const result=await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id});
      assert.equal(result.code,index===0?'broadcast_unknown':'broadcast_budget_exhausted');
    }
    const state=await storage.read(),saved=(await storage.rpc('operational')).finite_scope;
    assert.equal(saved.transactions,1);assert.equal(saved.fee_units,first.fee_units);assert.equal(saved.new_locked_units,first.new_locked_units);
    assert.equal(saved.broadcasts,2);assert.equal(attempts.length,2);assert(attempts.every(raw=>raw===state.claims[0].raw));
    assert.equal(state.coordinator.generation,1);assert.equal(state.claims[0].attempts,2);
  }finally {await db.close();}
});

test('acceptance CLI returns nonzero on insufficient fee without signing or raw persistence',()=>{
  const program=`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { bindings,config,databaseFixture,chainFixture } from './tests/publisher-fixture.js';
    import { runPublisher } from './leaderboard/publisher.js';
    import { admit } from './leaderboard/issuer.js';
    import { verifyClaim } from './leaderboard/verify.js';
    import { canonical,receiptId } from './leaderboard/receipt.js';
    const {db,storage}=await databaseFixture(),chain=chainFixture();
    try {
      await runPublisher(storage,config,{fetch:chain.fetch});
      const {playerClaim}=JSON.parse(readFileSync('./tests/fixtures/receipt.json'));
      await admit(storage,verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)));
      Object.assign(process.env,bindings);
      globalThis.fetch=async(url,init)=>{
        if(String(url).startsWith(bindings.SUPABASE_URL)) {
          const {operation,payload}=JSON.parse(init.body);
          return Response.json(await(String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
        }
        return chain.fetch(url,init);
      };
      process.argv=[process.execPath,new URL('./tests/live-publisher-acceptance.js',import.meta.url).pathname.slice(1),
        '--publish','--name=g/huarong-lb','--max-broadcasts=1','--max-fee-units=1','--max-new-locked-units=1000600'];
      await import('./tests/live-publisher-acceptance.js');
      const state=await storage.read();assert.equal(state.claims[0].raw,null);assert.equal(state.claims[0].state,'queued');
      assert.equal(state.coordinator.generation,0);assert.equal(chain.broadcasts.length,0);
    }finally {await db.close();}
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',timeout:30000});
  assert.equal(child.error,undefined);assert.equal(child.status,1,child.stderr);
  const result=JSON.parse(child.stdout.trim());assert.equal(result.ok,false);assert.equal(result.code,'spend_budget_exhausted');
});

test('begin rechecks budget and atomically reserves it despite a lost response; cron never takes over',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await queueClaim(storage,chain);
    const scope=await openScope(storage),runtime=await storage.rpc('job',{owner:'scoped',scope:scope.id});
    const state=await storage.read(),claim=state.claims[0];
    const provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},allowUnprovenNameAbsence:true,fetch:chain.fetch});
    const observation=await provider.prepare(claim);
    const lease=await storage.rpc('prepare',{scope:scope.id,job:'scoped',id:claim.id,owner:'signer',revision:state.coordinator.revision,
      epoch:observation.epoch,head:observation.head,prepared:observation.prepared});
    assert.equal(lease.state,'unsigned_preparing');
    await db.exec("update public.hd1_runtime set finite_scope=jsonb_set(finite_scope,'{fee_units}','100000');");
    const payload={scope:scope.id,job:'scoped',id:claim.id,owner:'signer',generation:lease.generation,
      revision:lease.evaluation_revision,epoch:observation.epoch,head:observation.head,prepared:observation.prepared};
    assert.equal((await storage.rpc('begin',payload)).code,'spend_budget_exhausted');
    assert.equal((await storage.read()).claims[0].state,'unsigned_preparing');
    assert.equal((await storage.read()).claims[0].raw,null);
    await db.exec("update public.hd1_runtime set finite_scope=jsonb_set(finite_scope,'{fee_units}','0');");
    const lost={...storage,rpc:async(operation,data)=>{const result=await storage.rpc(operation,data);if(operation==='begin')throw Error('lost_begin');return result;}};
    await assert.rejects(lost.rpc('begin',payload),/lost_begin/);
    const before=await storage.read(),saved=(await storage.rpc('operational')).finite_scope;
    assert.equal(before.claims[0].state,'signing_started');assert.equal(before.claims[0].raw,null);
    assert.equal(saved.transactions,1);assert.equal(saved.fee_units,observation.prepared.fee);
    assert.equal(saved.reservations[claim.id].generation,lease.generation);
    await db.exec("update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id})).code,'publisher_unavailable');
    assert.equal((await storage.read()).claims[0].state,'signing_started');
    assert.equal((await storage.read()).coordinator.generation,1);assert.equal(chain.broadcasts.length,0);
    assert.deepEqual((await storage.rpc('operational')).finite_scope,saved);
    assert.equal(runtime.owner,'scoped');
  }finally {await db.close();}
});
