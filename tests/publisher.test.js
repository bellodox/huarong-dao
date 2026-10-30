import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runPublisher,publisherConfig,deriveMarker } from '../leaderboard/publisher.js';
import { canonical,receiptId,base58check,signPlayer,bytesToHex } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit } from '../leaderboard/issuer.js';
import { advance } from '../leaderboard/issuer.js';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';
import { migrations } from './schema.js';
import { bindings,config,secret,appKey,chainFixture,databaseFixture,connectDatabase,payment,markerKey,txidOf } from './publisher-fixture.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
const tick=(storage,chain)=>runPublisher(storage,config,{fetch:chain.fetch});
test('runtime config defaults: four bindings, public-only marker, retired key ignored, legacy WIF rejected precisely',()=>{
  assert(!config.code);assert.equal(config.markerKey,deriveMarker(bytesToHex(appKey)));
  assert.equal(publisherConfig({ROD_EXPERIMENT_ISSUER_WIF:bindings.ROD_APP_WIF}).code,'issuer_not_configured');
  assert.equal(publisherConfig({...bindings,ROD_APP_WIF:base58check(Uint8Array.from([78,...secret]))}).code,'funding_compression_incompatible');
  assert.equal(publisherConfig({...bindings,HD1_PUBLISHER:'false'}).code,'issuance_disabled');
});
test('availability authenticates split funding and recovers automatically after funding arrives',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    // Remove the single large funding payment, keeping the hash-authenticated header intact.
    const existing=[...chain.txs.keys()][0];chain.txs.delete(existing);
    await tick(storage,chain);assert.equal((await storage.publicRead('readiness')).code,'funds_unavailable');
    chain.mine([payment('split-a',appKey,600000),payment('split-b',appKey,600000)]);
    assert.equal((await tick(storage,chain)).code,'ready');
    assert.equal((await storage.publicRead('readiness')).available,true);
    assert.equal(chain.broadcasts.length,0);
  }finally {await db.close();}
});
test('003 upgrade recovers only its authenticated exact registration journal, retaining 002 outbox and barriers',async()=>{
  const db=new PGlite(),chain=chainFixture();
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(migrations('003_live_publisher.sql'));await db.exec('update public.hd1_coordinator set paused=false,epoch=2900;');
    const storage=connectDatabase(db);await admit(storage,verified);
    const provider=createSpaceXpanseProvider({appKey:config.appKey,markerKey:config.markerKey,anchor:{height:100,hash:chain.blocks[0].hash},
      allowUnprovenNameAbsence:true,baseUrl:config.baseUrl,fetch:chain.fetch});
    await advance(storage,provider,secret,markerKey,verified.id);
    const original=(await storage.read()).claims[0];
    chain.mine([original.raw]);
    await db.exec(readFileSync(new URL('../supabase/migrations/003_live_publisher.sql',import.meta.url),'utf8'));
    const beforeFinite=await storage.read(),beforeRuntime=await storage.rpc('operational');
    assert.equal((await tick(storage,chain)).code,'schema_upgrade_required');
    assert.deepEqual(await storage.read(),beforeFinite);assert.deepEqual(await storage.rpc('operational'),beforeRuntime);
    await db.exec(readFileSync(new URL('../supabase/migrations/004_finite_publication.sql',import.meta.url),'utf8'));
    assert.deepEqual(await storage.read(),beforeFinite);
    assert.deepEqual(await storage.rpc('operational'),{...beforeRuntime,finite_scope:null});
    assert.equal((await tick(storage,chain)).code,'ready');
    const runtime=await storage.rpc('operational'),row=(await storage.read()).claims[0];
    assert.equal(runtime.bootstrap,original.txid);assert.equal(runtime.bootstrap_claim,original.id);
    assert.equal(row.raw,original.raw);assert.equal(row.state,'included');
    assert.equal(chain.broadcasts.length,1);assert.equal((await storage.read()).coordinator.generation,1);
  }finally {await db.close();}
});
test('SQL scheduler: bootstrap persistence, duplicate delivery, queued recovery, one/six confirmations and immutable outbox',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    assert.equal((await tick(storage,chain)).code,'ready');
    assert.equal((await storage.publicRead('readiness')).available,true);
    const initial=await storage.rpc('operational');assert(initial.config.anchor.height>0);
    assert.equal((await admit(storage,verified)).state,'queued');
    const results=await Promise.all([tick(storage,chain),tick(storage,chain)]);
    assert(results.some(row=>row.code==='job_busy'));
    let state=await storage.read(),row=state.claims[0];
    assert.equal(row.state,'broadcast_unknown');assert.equal(chain.broadcasts.length,1);
    assert.equal((await storage.rpc('operational')).bootstrap,row.txid);
    assert.equal(txidOf(row.raw),row.txid);
    const immutable={raw:row.raw,txid:row.txid,generation:row.generation};
    await tick(storage,chain);assert.equal(chain.broadcasts.length,1);
    const {s,...unsigned}=playerClaim,other=signPlayer({...unsigned,n:'Other'},Uint8Array.from([...Array(31).fill(0),4]));
    assert.equal((await admit(storage,verifyClaim(canonical(other,7),receiptId(other)))).state,'queued');
    await tick(storage,chain);assert.equal(chain.broadcasts.length,1);
    chain.mine([row.raw]);await tick(storage,chain);
    state=await storage.read();assert.equal(state.claims[0].state,'included');
    assert.equal(chain.broadcasts.length,2); // successor only after reconciled inclusion
    const successor=state.claims.find(q=>q.id!==row.id);assert(successor.raw);
    for(let i=0;i<5;i++)chain.mine();await tick(storage,chain);
    state=await storage.read();row=state.claims.find(q=>q.id===row.id);
    assert.equal(row.state,'confirmed');assert.deepEqual({raw:row.raw,txid:row.txid,generation:row.generation},immutable);
    assert.equal(state.coordinator.snapshot.receipts.length,1);
    assert.equal((await storage.rpc('operational')).bootstrap,immutable.txid);
  }finally {await db.close();}
});
test('checkpoint preserves pending twelve-confirmation weekly-close transitions',async()=>{
  const {reconstruct}=await import('../leaderboard/reconcile.js');
  const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
  const all=reconstruct(history),cut=history.headers.at(-1).height-5;
  const prefix=reconstruct({...history,headers:history.headers.filter(row=>row.height<=cut),transactions:history.transactions.filter(row=>row.height<=cut)});
  const checkpoint={...prefix,bootstrap:history.bootstrap.txid};
  const suffix=reconstruct({...history,checkpoint,anchor:{height:Math.max(0,cut-10),hash:history.headers[Math.max(0,cut-10)].hash},
    headers:history.headers.filter(row=>row.height>=Math.max(0,cut-10)),transactions:history.transactions.filter(row=>row.height>cut)});
  assert.deepEqual(suffix.receipts,all.receipts);assert.deepEqual(suffix.finalizedEpochs,all.finalizedEpochs);
});
test('cold bounded catch-up and rolling checkpoint extend without original-anchor refetch',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await tick(storage,chain);await admit(storage,verified);await tick(storage,chain);
    const row=(await storage.read()).claims[0];chain.mine([row.raw]);await tick(storage,chain);
    for(let i=0;i<220;i++)chain.mine();
    let attempts=0;while(!(await tick(storage,chain)).code.match(/ready/) && ++attempts<8){}
    let runtime=await storage.rpc('operational');assert(runtime.document.checkpoint?.head);
    const revision=(await storage.read()).coordinator.revision;
    chain.calls.length=0;
    assert.equal((await runPublisher(storage,config,{fetch:chain.fetch,providerOptions:{maxHeaderSpan:1}})).code,'ready');
    const ranges=chain.calls.filter(path=>path.startsWith('/range/'));
    assert.equal(ranges.filter(path=>path.endsWith('?offset=30')).length,1);
    assert(ranges.filter(path=>!path.endsWith('?offset=30')).every(path=>path.endsWith('?offset=1')));
    assert(!ranges.some(path=>path.startsWith('/range/'+runtime.config.anchor.height+'?')));
    assert.equal((await storage.read()).coordinator.revision,revision);
    const cut=runtime.document.checkpoint.height;
    assert(runtime.document.headers[0].height>=cut-10);
    // Fixed original maxHeaderSpan does not govern the durable incremental follower.
    const oldAnchor=runtime.config.anchor;assert(oldAnchor.height<cut-10);
  }finally {await db.close();}
});
test('SQL job lease fences expired owners, reclaims only unsigned work, and preserves grants/read-only readiness',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await tick(storage,chain);await admit(storage,verified);
    const first=await storage.rpc('job',{owner:'first'});
    assert.equal((await storage.rpc('job',{owner:'overlap'})).code,'job_busy');
    await db.exec("update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    const second=await storage.rpc('job',{owner:'second'});
    assert.equal((await storage.rpc('save',{job:'first',version:first.version,document:{}})).code,'stale_job');
    assert.equal((await storage.rpc('initialize',{job:'second',config:{...second.config,markerKey:second.config.appKey}})).code,'identity_configuration_mismatch');
    assert.equal((await storage.rpc('operational')).config.markerKey,config.markerKey);
    const state=await storage.read();
    const lease=await storage.rpc('prepare',{job:'second',id:verified.id,owner:'unsigned',revision:state.coordinator.revision,
      epoch:2900,head:null,prepared:{operation:'register',inputs:[{txid:'ab'.repeat(32),index:0}]}});
    assert.equal(lease.state,'unsigned_preparing');
    await db.exec("update public.hd1_claims set expires=clock_timestamp()-interval '1 second';update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    await storage.rpc('job',{owner:'third'});
    assert.equal((await storage.read()).claims[0].state,'queued');
    assert.equal((await storage.read()).coordinator.active,null);
    await db.exec('set role service_role;begin read only;');
    assert.equal((await storage.publicRead('readiness')).trust,'provider_anchored');
    await db.exec('rollback;set role service_role;');
    await assert.rejects(db.query('select * from public.hd1_runtime'),/permission denied/);
    await assert.rejects(db.query("select public.hd1_rpc_v2('read','{}')"),/permission denied/);
    await assert.rejects(db.query("select public.hd1_public_v2('leaderboard','{}')"),/permission denied/);
    await db.exec('reset role;set role anon;');
    await assert.rejects(storage.publicRead('readiness'),/permission denied/);
  }finally {await db.close();}
});
test('reorg and external spend halt readiness without repeated revision churn or alternate signing',async()=>{
  for(const kind of ['reorg','external']) {
    const {db,storage}=await databaseFixture(),chain=chainFixture();
    try {
      await tick(storage,chain);await admit(storage,verified);await tick(storage,chain);
      const row=(await storage.read()).claims[0];chain.mine([row.raw]);await tick(storage,chain);
      if(kind==='reorg') {
        const orphan=chain.blocks.pop();for(const id of orphan.tx)chain.txs.delete(id);chain.mine();
      }else {
        const route=chain.route;
        chain.route=(path,init)=>path.startsWith('/unspent/')?route(path,init).filter(item=>item.txid!==row.txid||item.index!==0):route(path,init);
      }
      await tick(storage,chain);
      const paused=await storage.read();assert.equal(paused.coordinator.paused,true);
      assert.equal((await storage.publicRead('readiness')).available,false);
      await tick(storage,chain);
      const after=await storage.read();
      assert.equal(after.coordinator.revision,paused.coordinator.revision);
      assert.equal(after.coordinator.generation,1);assert.equal(chain.broadcasts.length,1);
      assert.equal(after.claims[0].raw,row.raw);
    }finally {await db.close();}
  }
});
test('benign tip reorg reconciles automatically; changed history page and expired readiness fail closed',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await tick(storage,chain);await admit(storage,verified);await tick(storage,chain);
    const row=(await storage.read()).claims[0];chain.mine([row.raw]);await tick(storage,chain);
    for(let i=0;i<8;i++)chain.mine();await tick(storage,chain);
    chain.blocks.pop();chain.mine([payment('benign')]);
    await tick(storage,chain);
    assert.equal((await storage.publicRead('readiness')).available,true);
    assert.equal((await storage.read()).claims[0].state,'confirmed');assert.equal(chain.broadcasts.length,1);
    await db.exec("update public.hd1_runtime set checked_at=clock_timestamp()-interval '4 minutes';");
    assert.equal((await storage.publicRead('readiness')).available,false);
    assert.equal((await storage.publicRead('readiness')).code,'publisher_stale');
    let reads=0;chain.hooks.any=path=>{
      if(path.startsWith('/history/')&&++reads===2)return Response.json({error:null,result:{txcount:0,tx:[]}});
    };
    await tick(storage,chain);assert.equal((await storage.publicRead('readiness')).available,false);
    assert.equal((await storage.publicRead('readiness')).code,'history_changed');
    assert.equal((await storage.read()).coordinator.generation,1);
  }finally {await db.close();}
});
test('four identical-byte attempts maximum, temporary provider outage resumes, bootstrap identity cannot be replaced',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await tick(storage,chain);await admit(storage,verified);
    const normal=chain.fetch;
    let outage=true;
    chain.fetch=async(url,init)=>{if(outage&&url.endsWith('/info'))throw Error('private-url-secret');return normal(url,init);};
    await tick(storage,chain);assert.equal((await storage.publicRead('readiness')).available,false);
    outage=false;chain.hooks.any=(path)=>{if(path==='/broadcast')throw Error('ambiguous_timeout');};
    // Record actual attempted raw even though the fixture does not acknowledge or mine it.
    const failed=[];chain.fetch=async(url,init)=>{if(url.endsWith('/broadcast'))failed.push(new URLSearchParams(init.body).get('raw'));return normal(url,init);};
    for(let i=0;i<6;i++) {
      await db.exec("update public.hd1_claims set retry_at=clock_timestamp()-interval '1 second';");
      await tick(storage,chain);
    }
    const row=(await storage.read()).claims[0];
    assert.equal(row.attempts,4);assert.equal(failed.length,4);assert(failed.every(raw=>raw===row.raw));
    assert.equal((await storage.publicRead('readiness')).code,'retry_exhausted');
    const pinned=(await storage.rpc('operational')).bootstrap;
    await runPublisher(storage,{...config,bootstrap:'ab'.repeat(32)},{fetch:chain.fetch});
    assert.equal((await storage.rpc('operational')).bootstrap,pinned);
    assert.equal((await storage.publicRead('readiness')).code,'identity_configuration_mismatch');
  }finally {await db.close();}
});
test('lost finalize response pins bootstrap atomically; restart recovers exact bytes without another signer',async()=>{
  const directory=mkdtempSync(new URL('./.publisher-restart-',import.meta.url));
  let {db,storage}=await databaseFixture(directory);const chain=chainFixture();
  try {
    await tick(storage,chain);await admit(storage,verified);
    const lossy={...storage,rpc:async(op,payload)=>{const result=await storage.rpc(op,payload);if(op==='finalize')throw Error('timeout');return result;}};
    await tick(lossy,chain);
    const row=(await storage.read()).claims[0];assert.equal(row.state,'signed_persisted');assert.equal(chain.broadcasts.length,0);
    assert.equal((await storage.rpc('operational')).bootstrap,row.txid);
    await db.close();db=new PGlite(directory);storage=connectDatabase(db);
    await tick(storage,chain);assert.deepEqual(chain.broadcasts,[row.raw]);
    assert.equal((await storage.read()).coordinator.generation,1);
  }finally {await db.close();rmSync(directory,{recursive:true,force:true});}
});
test('job expiry cannot take over signing_started; initial marker pagination resumes across ticks',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    for(let i=0;i<25;i++)chain.mine([payment('spam'+i,markerKey,700)]);
    assert.equal((await tick(storage,chain)).code,'initial_sync');
    const first=await storage.rpc('operational');assert.equal(first.document.scan.offset,10);
    assert.equal((await tick(storage,chain)).code,'initial_sync');
    const second=await storage.rpc('operational');assert.equal(second.document.scan.offset,20);
    for(let i=0;i<30;i++)await tick(storage,chain);
    assert.equal((await storage.publicRead('readiness')).available,true);
    await admit(storage,verified);
    const lossy={...storage,rpc:async(op,payload)=>{const result=await storage.rpc(op,payload);if(op==='begin')throw Error('lost begin');return result;}};
    await tick(lossy,chain);assert.equal((await storage.read()).claims[0].state,'signing_started');
    await db.exec("update public.hd1_runtime set expires=clock_timestamp()-interval '1 second';");
    await tick(storage,chain);assert.equal((await storage.publicRead('readiness')).available,false);
    assert.equal((await storage.publicRead('readiness')).code,'signing_unknown');
    assert.equal(chain.broadcasts.length,0);assert.equal((await storage.read()).coordinator.generation,1);
  }finally {await db.close();}
});
