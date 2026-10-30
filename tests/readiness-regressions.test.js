import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { bindings,config,appKey,markerKey,chainFixture,databaseFixture,connectDatabase,payment,txidOf } from './publisher-fixture.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { handleRelayRequest } from '../leaderboard/relay-entry.js';
import { liveAcceptance } from './live-publisher-acceptance.js';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { canonical,receiptId,bytesToHex } from '../leaderboard/receipt.js';
import { admit } from '../leaderboard/issuer.js';
import { serialize,payScript } from '../leaderboard/chain.js';
import { SupabaseStorage,publisherReadiness } from '../leaderboard/storage.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
/** Keep every operation in the local SQL/provider fixtures. */
function fixtureFetch(storage,chain) {
  return async(url,init)=>{
    if(String(url).startsWith(bindings.SUPABASE_URL)) {
      const {operation,payload}=JSON.parse(init.body);
      return Response.json(await(String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
    }
    return chain.fetch(url,init);
  };
}

test('001 through 003 cannot advertise readiness or publish; 004 installs capability without changing journals',async()=>{
  for(const before of ['002_d6_included_successor.sql','003_live_publisher.sql','004_finite_publication.sql']) {
    const db=new PGlite(),chain=chainFixture(),original=globalThis.fetch;
    try {
      await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(migrations(before));
      const storage=connectDatabase(db);
      await db.exec('update public.hd1_coordinator set paused=false,epoch=2900;');await admit(storage,verified);
      if(before==='004_finite_publication.sql')await db.query("update public.hd1_runtime set ready=true,code='ready',checked_at=clock_timestamp(),config=$1::jsonb",
        [JSON.stringify({appKey:config.appKey,markerKey:config.markerKey,baseUrl:config.baseUrl,anchor:{height:100,hash:chain.blocks[0].hash}})]);
      const journal=await storage.read();globalThis.fetch=fixtureFetch(storage,chain);
      const response=await handleRelayRequest(new Request('https://game.test/api/leaderboard'),bindings);
      const publicResult=await response.json();assert.equal(publicResult.available,false);
      assert.equal(publicResult.publisher.code,'schema_upgrade_required');
      const post=await handleRelayRequest(new Request('https://game.test/api/score',{method:'POST',headers:{origin:'https://game.test'}}),bindings);
      assert.equal(post.status,503);assert.equal((await post.json()).code,'schema_upgrade_required');
      assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'schema_upgrade_required');
      assert.deepEqual(await storage.read(),journal);assert.equal(chain.calls.length,0);assert.equal(chain.broadcasts.length,0);
      if(before==='004_finite_publication.sql') {
        await db.exec(readFileSync(new URL('../supabase/migrations/004_finite_publication.sql',import.meta.url),'utf8'));
        assert.deepEqual(await storage.read(),journal);
        assert.equal((await storage.publicRead('readiness')).capability_revision,4);
        assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'broadcast_pending');
        assert.equal(chain.broadcasts.length,1);assert.equal((await storage.read()).coordinator.generation,1);
      }
    }finally {globalThis.fetch=original;await db.close();}
  }
});

test('acceptance explicitly resumes the existing scope after broadcast through inclusion and final six',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture(),fetcher=fixtureFetch(storage,chain);
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});await admit(storage,verified);
    const first=await liveAcceptance(bindings,['--publish','--name=g/huarong-lb','--max-broadcasts=1','--max-fee-units=100000','--max-new-locked-units=1000600'],{fetch:fetcher});
    assert.equal(first.broadcasts,1);const saved=(await storage.rpc('operational')).finite_scope;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    chain.mine([chain.broadcasts[0]]);
    const resumed=await liveAcceptance(bindings,['--resume-scope='+first.scope_id],{fetch:fetcher});
    assert.equal(resumed.ok,true);assert.equal(resumed.mode,'finite_resume');assert.equal(resumed.broadcasts,0);
    assert.equal((await storage.read()).claims[0].state,'included');
    for(let i=0;i<5;i++)chain.mine();
    assert.equal((await liveAcceptance(bindings,['--resume-scope='+first.scope_id],{fetch:fetcher})).ok,true);
    assert.equal((await storage.read()).claims[0].state,'confirmed');
    assert.equal((await storage.read()).coordinator.snapshot.receipts.length,1);
    assert.deepEqual((await storage.rpc('operational')).finite_scope,saved);assert.equal(chain.broadcasts.length,1);
  }finally {await db.close();}
});

/** Run the actual CLI entry in a fresh process; only this test's loopback server is reachable. */
function acceptanceCli(origin,args) {
  const program=`
    import { bindings } from './tests/publisher-fixture.js';
    import { fileURLToPath } from 'node:url';
    Object.assign(process.env,bindings);
    const localFetch=globalThis.fetch;
    globalThis.fetch=(url,init)=>{
      const target=new URL(url),base=target.origin===bindings.SUPABASE_URL?'/db':target.origin===bindings.ROD_API_URL?'/provider':null;
      if(!base)throw Error('fixture_only');
      return localFetch(${JSON.stringify(origin)}+base+target.pathname+target.search,init);
    };
    process.argv=[process.execPath,fileURLToPath(new URL('./tests/live-publisher-acceptance.js',import.meta.url)),...${JSON.stringify(args)}];
    await import('./tests/live-publisher-acceptance.js');
  `;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',program],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error('fixture_cli_timeout'));},30000);
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',status=>{clearTimeout(timer);try {resolve({status,result:JSON.parse(stdout.trim()),stderr});}catch {reject(Error('fixture_cli_output:'+stderr));}});
  });
}

test('fresh acceptance CLI processes resume initial sync, lost exact-raw responses and final six under the durable lock',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();let lost=null;
  const server=createServer(async(request,response)=>{
    try {
      let body='';for await(const chunk of request)body+=chunk;
      let result,operation;
      if(request.url.startsWith('/db/')) {
        const parsed=JSON.parse(body);operation=parsed.operation;
        result=await(request.url.endsWith('hd1_public')?storage.publicRead(operation,parsed.payload):storage.rpc(operation,parsed.payload));
      }else result=chain.route(request.url.replace(/^\/provider/,''),{method:request.method,body});
      if(lost===operation||lost==='transport'&&request.url==='/provider/broadcast') {lost=null;response.destroy();return;}
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify(request.url.startsWith('/db/')?result:{error:null,result}));
    }catch(error) {response.statusCode=500;response.end(JSON.stringify({code:'P0001',message:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});await admit(storage,verified);
    chain.mine([payment('resume-spam-1',markerKey,700),payment('resume-spam-2',markerKey,700)]);
    const first=await acceptanceCli(origin,['--publish','--name=g/huarong-lb','--max-broadcasts=1','--max-fee-units=100000','--max-new-locked-units=1000600']);
    assert.equal(first.status,0,first.stderr);assert.deepEqual(first.result.outcomes,['initial_sync']);
    const initial=(await storage.rpc('operational')).finite_scope,id=initial.id,args=['--resume-scope='+id];
    const locked=await storage.rpc('job',{owner:'other-acceptance',scope:id});assert.equal(locked.owner,'other-acceptance');
    const busy=await acceptanceCli(origin,args);assert.equal(busy.status,1);assert.equal(busy.result.code,'job_busy');
    await storage.rpc('job_done',{job:'other-acceptance'});
    for(const extra of [['--publish'],['--max-broadcasts=4'],['--max-fee-units=100000'],['--name=g/huarong-lb'],['--check-sql'],[args[0]]])
      await assert.rejects(liveAcceptance(bindings,[...args,...extra],{fetch:fixtureFetch(storage,chain)}),/invalid_scope/);
    const wrong=await acceptanceCli(origin,['--resume-scope='+crypto.randomUUID()]);assert.equal(wrong.status,1);assert.equal(wrong.result.code,'finite_scope_mismatch');
    assert.deepEqual((await storage.rpc('operational')).finite_scope,initial);
    lost='finalize';
    const finalized=await acceptanceCli(origin,[...args,'--ticks=10']);
    assert.equal(finalized.status,1);assert.equal(finalized.result.code,'publisher_unavailable');
    const signed=(await storage.read()).claims[0];assert.equal(signed.state,'signed_persisted');assert(signed.raw);assert.equal(chain.broadcasts.length,0);
    const reserved=(await storage.rpc('operational')).finite_scope;assert.equal(reserved.transactions,1);assert.equal(reserved.broadcasts,0);
    assert.deepEqual(reserved.claims,initial.claims);assert.equal(reserved.max_transactions,initial.max_transactions);
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'finite_scope_required');
    lost='transport';const broadcast=await acceptanceCli(origin,args);
    assert.equal(broadcast.status,0,broadcast.stderr);assert.deepEqual(broadcast.result.outcomes,['broadcast_unknown']);
    assert.deepEqual(chain.broadcasts,[signed.raw]);
    const attempted=(await storage.rpc('operational')).finite_scope;assert.equal(attempted.broadcasts,1);
    const pending=await acceptanceCli(origin,args);assert.equal(pending.status,0);assert.equal(chain.broadcasts.length,1);
    chain.mine([signed.raw]);assert.equal((await acceptanceCli(origin,args)).status,0);
    assert.equal((await storage.read()).claims[0].state,'included');
    for(let i=0;i<5;i++)chain.mine();assert.equal((await acceptanceCli(origin,args)).status,0);
    const state=await storage.read();assert.equal(state.claims[0].state,'confirmed');assert.equal(state.coordinator.snapshot.receipts.length,1);
    assert.equal(state.claims[0].raw,signed.raw);assert.equal(state.claims[0].txid,signed.txid);assert.equal(state.coordinator.generation,1);
    assert.deepEqual((await storage.rpc('operational')).finite_scope,attempted);assert.equal(chain.broadcasts.length,1);
    assert.equal((await storage.rpc('finite_open',{id:crypto.randomUUID()})).code,'finite_scope_exists');
  }finally {await new Promise(resolve=>server.close(resolve));await db.close();}
});

test('new confirmed funding is not hidden behind nine old dust outputs in readiness or preparation',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    chain.txs.clear();
    for(let i=0;i<9;i++)chain.mine([payment('old-dust-'+i,appKey,600)]);
    const large=payment('new-funds',appKey,10000000);chain.mine([large]);
    chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'ready');assert(chain.calls.length<=36);
    const provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},allowUnprovenNameAbsence:true,fetch:chain.fetch});
    const observation=await provider.prepare({bytes:verified.text});
    assert.equal(observation.prepared.inputs.length,1);assert.equal(observation.prepared.inputs[0].txid,txidOf(large));
    await admit(storage,verified);chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'broadcast_pending');assert(chain.calls.length<=36);
    assert.equal((await storage.read()).claims[0].prepared.inputs[0].previousRaw,large);
  }finally {await db.close();}
});

test('candidate search skips nine immature outputs and unusable scripts without counting them as selected inputs',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    chain.txs.clear();
    const immature=Array.from({length:9},(_,index)=>bytesToHex(serialize({version:1,inputs:[{txid:'0'.repeat(64),index:0xffffffff,script:Uint8Array.of(index+1)}],
      outputs:[{amount:20000000+index,script:payScript(appKey)}],locktime:0})));
    const unusable=bytesToHex(serialize({version:1,inputs:[{txid:'ab'.repeat(32),index:0}],
      outputs:[{amount:15000000,script:Uint8Array.from([0x51,...payScript(appKey)])}],locktime:0}));
    const valid=payment('usable-after-immature',appKey,10000000);chain.mine([...immature,unusable,valid]);
    const route=chain.route;let includeValid=false;
    chain.route=(path,init)=>{
      const rows=route(path,init);if(!path.startsWith('/unspent/'))return rows;
      return [...rows.filter(row=>includeValid||row.txid!==txidOf(valid)),
        {txid:'dd'.repeat(32),index:0,value:100000000,height:0},
        {txid:'ee'.repeat(32),index:0,value:100000000,height:chain.tip().height+1}];
    };
    chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'publisher_unavailable');
    assert.equal((await storage.publicRead('readiness')).code,'funds_unavailable');assert(chain.calls.length<=36);
    const provider=()=>createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},allowUnprovenNameAbsence:true,fetch:chain.fetch});
    await assert.rejects(provider().prepare({bytes:verified.text}),/funds_unavailable/);
    includeValid=true;chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'ready');assert(chain.calls.length<=36);
    const prepared=(await provider().prepare({bytes:verified.text})).prepared;
    assert.equal(prepared.inputs.length,1);assert.equal(prepared.inputs[0].previousRaw,valid);
    assert(!chain.calls.some(path=>path==='/transaction/'+'dd'.repeat(32)||path==='/transaction/'+'ee'.repeat(32)));
    await admit(storage,verified);chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch})).code,'broadcast_pending');assert(chain.calls.length<=36);
    assert.equal((await storage.read()).claims[0].prepared.inputs[0].previousRaw,valid);
  }finally {await db.close();}
});

test('funding candidate and selected-input bounds remain independent and finite',async()=>{
  const chain=chainFixture();chain.txs.clear();
  const unusable=Array.from({length:20},(_,index)=>bytesToHex(serialize({version:1,inputs:[{txid:'ab'.repeat(32),index}],
    outputs:[{amount:20000000-index,script:Uint8Array.from([0x51,...payScript(appKey)])}],locktime:0})));
  chain.mine(unusable);
  const make=()=>createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},fetch:chain.fetch});
  const api=make().primitives,tip=await api.tipInfo();chain.calls.length=0;
  await assert.rejects(api.selectFunding(tip,null,()=>true),/funds_unavailable/);
  assert.equal(chain.calls.filter(path=>path.startsWith('/transaction/')).length,12);
  chain.txs.clear();chain.mine(Array.from({length:12},(_,index)=>payment('split-limit-'+index,appKey,100000)));
  let selected=0;
  const bounded=make().primitives;
  await assert.rejects(bounded.selectFunding(await bounded.tipInfo(),null,inputs=>{selected=inputs.length;return false;}),/funds_unavailable/);
  assert.equal(selected,9);
});

test('schema capability is STABLE, service-only and missing-schema envelopes are actionable without masking outages',async()=>{
  for(const envelope of [{code:'P0001',message:'invalid_query'},{code:'PGRST202',message:'schema cache missing'}]) {
    const storage=new SupabaseStorage(bindings.SUPABASE_URL,'public-fixture',async()=>Response.json(envelope,{status:400}));
    assert.equal((await publisherReadiness(storage)).code,'schema_upgrade_required');
  }
  const unavailable=new SupabaseStorage(bindings.SUPABASE_URL,'public-fixture',async()=>Response.json({code:'private_backend_error'},{status:503}));
  await assert.rejects(publisherReadiness(unavailable),/storage_unavailable/);
  const {db,storage}=await databaseFixture();
  try {
    await db.exec('set role service_role;begin read only;');
    assert.equal((await storage.publicRead('readiness')).capability_revision,4);
    await db.exec('rollback;set role service_role;');
    await assert.rejects(db.query("select public.hd1_public_v3('readiness','{}')"),/permission denied/);
    await db.exec('reset role;set role anon;');
    await assert.rejects(storage.publicRead('readiness'),/permission denied/);
  }finally {await db.close();}
});
