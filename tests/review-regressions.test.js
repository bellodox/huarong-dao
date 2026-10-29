import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { buildTransaction,signTransaction,serialize,payScript } from '../leaderboard/chain.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { canonical,parseCanonical,signPlayer,signApp,recover,receiptId,bytesToHex } from '../leaderboard/receipt.js';
import { CATALOG } from '../leaderboard/profile.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { handleApi } from '../worker.js';
import { reconcile } from '../leaderboard/reconcile.js';
import { admit,advance } from '../leaderboard/issuer.js';
import { parseTransaction } from '../leaderboard/chain.js';
const paths=JSON.parse(readFileSync(new URL('./fixtures/paths.json',import.meta.url)));
const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
const secret=number=>Uint8Array.from([...Array(31).fill(0),number]);

const app=secret(2),marker=secp256k1.getPublicKey(secret(3));
const forbidden=new Proxy({},{get(){throw Error('reconciled spend must not touch chain/signing');}});

/** Exercise the real ordered SQL migrations and operational RPC, never hosted storage. */
async function setup(directory) {
  const db=new PGlite(directory);await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(migrations());
  return {db,storage:connect(db)};
}
function connect(db) {
  const storage={rpc:async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value};
  storage.read=()=>storage.rpc('read');return storage;
}
/** Fixture lineage extended by exact raw spends at heights 3..; the tip has the given confirmations.
 * Stands in for independently authenticated canonical observations. */
function chainWith(extra,confirmations) {
  const transactions=[...history.transactions,...extra.map((raw,index)=>({raw,height:3+index,index:0,blockHash:history.headers[3+index].hash}))];
  return {history:async()=>({...history,transactions,headers:history.headers.slice(0,2+extra.length+confirmations)})};
}
/** A distinct player's legitimate ranked claim. */
function claimFor(number,nickname) {
  const path=paths.find(row=>row.l==='wings');
  const claim=signPlayer({p:'hd1',w:2900,l:path.l,b:path.b,n:nickname,m:path.m},secret(number));
  return verifyClaim(canonical(claim,7),receiptId(claim));
}
/** Prepare a full-script update spending the given name transaction's output 0. */
function transport(broadcasts,previousRaw=history.transactions.at(-1).raw) {
  const previous=parseTransaction(previousRaw),head=previous.txid+':0';
  return {prepare:async()=>({epoch:2900,head,prepared:{operation:'update',fee:40000,markerAmount:10000,nameAmount:previous.outputs[0].amount-60000,
    inputs:[{txid:previous.txid,index:0,amount:previous.outputs[0].amount,script:bytesToHex(previous.outputs[0].script),previousRaw}]}}),
    validate:async()=>true,lookup:async()=>null,broadcast:async raw=>{broadcasts.push(raw);throw Error('fixture timeout');}};
}
/** An app-signed spend produced elsewhere (e.g. another relay instance without our journal). */
async function foreignSpend(previousRaw,verified) {
  const {prepared}=await transport([],previousRaw).prepare();
  return signTransaction(buildTransaction(prepared,signApp(parseCanonical(verified.text,7),app),secp256k1.getPublicKey(app),marker),app);
}
const claimRow=async(storage,id)=>(await storage.read()).claims.find(row=>row.id===id);

test('D6: zero confirmations block, one reconciled confirmation permits exactly one successor, six finalize, twelve close unchanged',async()=>{
  const {db,storage}=await setup();const first=claimFor(4,'NextPlayer'),second=claimFor(5,'Second'),third=claimFor(6,'Third'),broadcasts=[];
  const finalized=async txid=>(await db.query('select count(*)::integer as n from public.hd1_receipts where txid=$1',[txid])).rows[0].n;
  try {
    // Authenticated included history WITHOUT a local journal does not block a successor.
    const rebuilt=await reconcile(storage,chainWith([],1));
    assert.equal(rebuilt.paused,false);assert.equal(rebuilt.snapshot.receipts.length,0);
    assert.deepEqual(rebuilt.snapshot.pending.map(row=>row.confirmations),[2,1]);
    for(const claim of [first,second,third])assert.equal((await admit(storage,claim)).state,'queued');
    const published=await advance(storage,transport(broadcasts),app,marker,first.id);
    assert.equal(published.state,'broadcast_unknown');assert.equal(broadcasts.length,1);
    // Zero confirmations: no successor, even if the active slot were lost.
    assert.equal((await advance(storage,transport(broadcasts),app,marker,second.id)).code,'signer_busy');
    await db.exec('update public.hd1_coordinator set active=null;');
    let {coordinator}=await storage.read();
    assert.equal((await storage.rpc('prepare',{id:second.id,owner:'other',revision:coordinator.revision,...(await transport([]).prepare())})).code,'signer_busy');
    // Reconciliation observing zero confirmations keeps the exact outstanding spend, not conflicted.
    await reconcile(storage,chainWith([],1));
    assert.equal((await claimRow(storage,first.id)).state,'broadcast_unknown');assert.equal((await claimRow(storage,first.id)).raw,published.raw);
    assert.equal((await advance(storage,transport(broadcasts),app,marker,second.id)).code,'signer_busy');assert.equal(broadcasts.length,1);
    // One canonical confirmation + reconciled head: predecessor included (not final), one successor.
    const included=await reconcile(storage,chainWith([published.raw],1));
    let row=await claimRow(storage,first.id);
    assert.equal(row.state,'included');assert.equal(row.confirmations,1);assert.equal(row.raw,published.raw);assert.equal(row.txid,published.txid);
    assert.equal(included.active,null);assert.equal(included.paused,false);assert.equal(included.head,published.txid+':0');
    assert.equal(await finalized(published.txid),0);
    assert.equal((await advance(storage,forbidden,app,marker,first.id)).state,'included');
    const successor=await advance(storage,transport(broadcasts,published.raw),app,marker,second.id);
    assert.equal(successor.state,'broadcast_unknown');assert.equal(broadcasts.length,2);assert.equal(broadcasts[1],successor.raw);
    // A lost finalize response can be read back forever without touching the successor's slot.
    const exact={id:published.id,owner:published.owner,generation:published.generation,raw:published.raw,txid:published.txid,receipt:published.receipt};
    assert.equal((await storage.rpc('finalize',exact)).state,'included');
    assert.equal((await storage.rpc('finalize',{...exact,raw:'00'})).code,'idempotency_conflict');
    assert.equal((await storage.read()).coordinator.active,second.id);
    assert.equal((await advance(storage,transport(broadcasts,published.raw),app,marker,third.id)).code,'signer_busy');assert.equal(broadcasts.length,2);
    // 1-5 confirmations: included only; 6: finalized. Twelve-confirmation weekly close is unchanged.
    for(const [confirmations,firstState,secondState,closed] of [[1,'included','included',[]],[4,'included','included',[]],[5,'confirmed','included',[]],[6,'confirmed','confirmed',[]],[7,'confirmed','confirmed',[]],[8,'confirmed','confirmed',[2899]]]) {
      const state=await reconcile(storage,chainWith([published.raw,successor.raw],confirmations));
      assert.equal(state.paused,false);assert.equal(state.head,successor.txid+':0');
      assert.equal((await claimRow(storage,first.id)).state,firstState);assert.equal((await claimRow(storage,second.id)).state,secondState);
      assert.equal(await finalized(published.txid),firstState==='confirmed'?1:0);assert.equal(await finalized(successor.txid),secondState==='confirmed'?1:0);
      assert.equal((await claimRow(storage,second.id)).confirmations,confirmations);assert.deepEqual(state.snapshot.finalizedEpochs,closed);
    }
    const next=await advance(storage,transport(broadcasts,successor.raw),app,marker,third.id);
    assert.equal(next.state,'broadcast_unknown');assert.equal(broadcasts.length,3);
    ({coordinator}=await storage.read());assert.equal(coordinator.generation,3);
  }finally{await db.close();}
});

for(const outstanding of ['queued','signing_started','broadcast_unknown'])test(`D6: six-to-five demotion preserves a same-slot ${outstanding} improvement`,async()=>{
  const {db,storage}=await setup(),broadcasts=[];
  const improvement=claimFor(4,'NextPlayer'),{s,...unsigned}=improvement.claim;
  const long=signPlayer({...unsigned,m:'Zb'.repeat((1536-unsigned.m.length)/2)+unsigned.m},secret(4));
  const predecessor=verifyClaim(canonical(long,7),receiptId(long));
  const publicBoard=async()=>(await db.query("select public.hd1_public('leaderboard','{}') as value")).rows[0].value;
  const exact=row=>({id:row.id,owner:row.owner,generation:row.generation,raw:row.raw,txid:row.txid,receipt:row.receipt});
  try {
    await reconcile(storage,chainWith([],1));
    assert.equal((await admit(storage,predecessor)).state,'queued');
    const published=await advance(storage,transport(broadcasts),app,marker,predecessor.id);
    const finalized=await reconcile(storage,chainWith([published.raw],6));
    assert.equal(finalized.paused,false);assert.equal((await claimRow(storage,predecessor.id)).state,'confirmed');
    assert.equal((await publicBoard()).rows.find(row=>row.player===predecessor.player).points,7);
    assert.equal((await admit(storage,improvement)).state,'queued');
    // The outstanding slot stays exclusive, independently of historical included receipts.
    await assert.rejects(db.query(`insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
      select repeat('f',64),bytes,player,nickname,layout,epoch,moves,points,'queued',evaluation_revision from public.hd1_claims where id=$1`,[improvement.id]),error=>error.code==='23505');
    if(outstanding==='broadcast_unknown')await advance(storage,transport(broadcasts,published.raw),app,marker,improvement.id);
    if(outstanding==='signing_started') {
      const lossy={read:storage.read,rpc:async(operation,payload)=>{const result=await storage.rpc(operation,payload);if(operation==='begin')throw Error('lost response');return result;}};
      await assert.rejects(advance(lossy,transport(broadcasts,published.raw),app,marker,improvement.id),/lost response/);
    }
    const before=await claimRow(storage,improvement.id),attempts=broadcasts.length;
    assert.equal(before.state,outstanding);
    // Same canonical transaction, shorter tip: remove finality without removing lineage or bytes.
    for(let repeat=0;repeat<2;repeat++) {
      const rebuilt=await reconcile(storage,chainWith([published.raw],5));
      assert.equal(rebuilt.paused,false);assert.equal(rebuilt.head,published.txid+':0');
      assert.equal(rebuilt.active,outstanding==='queued'?null:improvement.id);
      assert.equal(rebuilt.snapshot.receipts.some(row=>row.player===predecessor.player),false);
      const included=await claimRow(storage,predecessor.id);
      assert.equal(included.state,'included');assert.equal(included.confirmations,5);assert.equal(included.actual_epoch,2900);
      assert.deepEqual(exact(included),exact(published));assert.equal(included.attempts,published.attempts);
      assert.deepEqual(await claimRow(storage,improvement.id),before);
      const board=await publicBoard();assert.equal(board.stale,false);
      assert.equal(board.rows.some(row=>row.player===predecessor.player),false);
      assert.equal(board.pending.find(row=>row.receipt_id===predecessor.id).status,'included');
      assert.equal((await db.query('select count(*)::integer as n from public.hd1_receipts where player=$1',[predecessor.player])).rows[0].n,0);
      assert.equal((await admit(storage,predecessor)).state,'included');
      assert.deepEqual(exact(await storage.rpc('finalize',exact(published))),exact(published));
      assert.equal((await storage.rpc('finalize',{...exact(published),raw:'00'})).code,'idempotency_conflict');
      assert.equal((await advance(storage,forbidden,app,marker,predecessor.id)).state,'included');
      assert.equal((await storage.rpc('broadcast',exact(published))).code,'stale_owner');
    }
    const reservation={id:'e'.repeat(64),bytes:'new evidence',player:predecessor.player,nickname:'NextPlayer',layout:'wings',epoch:2900,moves:115,points:1};
    assert.equal((await storage.rpc('admit',{...reservation,nickname:'Renamed'})).code,'name_conflict');
    assert.equal((await storage.rpc('admit',{...reservation,moves:116})).state,'not_improved');
    assert.equal((await storage.rpc('admit',{...reservation,bytes:'changed evidence'})).code,'idempotency_conflict');
    assert.equal((await storage.rpc('admit',{...reservation,id:'d'.repeat(64)})).code,'queue_full');
    assert.equal(broadcasts.length,attempts);
    if(outstanding==='queued') {
      // The still-valid improvement can sign against the reconciled five-confirmation head.
      assert.equal((await advance(storage,transport(broadcasts,published.raw),app,marker,improvement.id)).state,'broadcast_unknown');
      assert.equal(broadcasts.length,attempts+1);
    }else {
      const other=claimFor(5,'Other');assert.equal((await admit(storage,other)).state,'queued');
      await db.exec('update public.hd1_coordinator set active=null;');
      const {coordinator}=await storage.read();
      assert.equal((await storage.rpc('prepare',{id:other.id,owner:'takeover',revision:coordinator.revision,...(await transport([],published.raw).prepare())})).code,'signer_busy');
      await db.query('update public.hd1_coordinator set active=$1',[improvement.id]);
      assert.equal((await storage.rpc('cancel',{id:improvement.id})).code,'barrier_locked');
      if(before.raw) {
        assert.deepEqual(exact(await storage.rpc('finalize',exact(before))),exact(before));
        assert.equal((await storage.rpc('finalize',{...exact(before),raw:'00'})).code,'idempotency_conflict');
        // Both same-slot receipts may now be canonical but non-final historical records.
        const included=await reconcile(storage,chainWith([published.raw,before.raw],4));
        assert.equal(included.paused,false);assert.equal(included.active,null);
        for(const [id,confirmations] of [[predecessor.id,5],[improvement.id,4]]) {
          const row=await claimRow(storage,id);assert.equal(row.state,'included');assert.equal(row.confirmations,confirmations);
          assert.equal((await advance(storage,forbidden,app,marker,id)).state,'included');
        }
        assert.deepEqual(exact(await claimRow(storage,improvement.id)),exact(before));
        assert.equal((await publicBoard()).rows.some(row=>row.player===predecessor.player),false);
      }else {
        assert.equal((await advance(storage,forbidden,app,marker,improvement.id)).state,'signing_started');
        assert.equal((await claimRow(storage,improvement.id)).raw,null);
      }
      assert.equal(broadcasts.length,attempts);
    }
  }finally{await db.close();}
});

test('D6: included reservations persist; reorg, lineage mismatch and external spend fail closed with exact bytes',async()=>{
  const {db,storage}=await setup();const first=claimFor(4,'NextPlayer'),second=claimFor(5,'Second'),broadcasts=[];
  try {
    const rebuilt=await reconcile(storage,chainWith([],1));
    // A reconstructed included receipt with no journal still reserves identity and improvement.
    const fixture=rebuilt.snapshot.pending.at(-1);
    const direct={id:'e'.repeat(64),bytes:'fixture-bytes',player:fixture.player,nickname:fixture.nickname,layout:fixture.layout,epoch:2900,points:1};
    assert.equal((await storage.rpc('admit',{...direct,nickname:'Renamed',moves:fixture.moves-1})).code,'name_conflict');
    assert.equal((await storage.rpc('admit',{...direct,moves:fixture.moves})).state,'not_improved');
    assert.equal((await admit(storage,first)).state,'queued');
    const published=await advance(storage,transport(broadcasts),app,marker,first.id);
    assert.equal(published.state,'broadcast_unknown');
    await reconcile(storage,chainWith([published.raw],1));
    // Journaled included predecessor keeps its name, best and week reservation and exact bytes.
    const same={id:'d'.repeat(64),bytes:'other-bytes',player:first.player,nickname:'NextPlayer',layout:'wings',epoch:2900,points:1};
    assert.equal((await storage.rpc('admit',{...same,nickname:'Other',moves:first.moves-1})).code,'name_conflict');
    assert.equal((await storage.rpc('admit',{...same,moves:first.moves})).state,'not_improved');
    const retried=await admit(storage,first);
    assert.equal(retried.state,'included');assert.equal(retried.raw,published.raw);assert.equal(retried.txid,published.txid);
    assert.equal((await storage.rpc('broadcast',{id:first.id,owner:published.owner,generation:published.generation})).code,'stale_owner');
    // Reorg removes the included predecessor: pause, keep bytes, never re-sign/rebroadcast.
    const reorged=await reconcile(storage,chainWith([],2));
    assert.equal(reorged.paused,true);assert.equal((await claimRow(storage,first.id)).state,'reorged');assert.equal((await claimRow(storage,first.id)).raw,published.raw);
    assert.equal((await admit(storage,second)).code,'reconciliation_required');
    assert.equal((await advance(storage,forbidden,app,marker,first.id)).state,'reorged');
    // Re-inclusion of the identical bytes restores inclusion and resumes issuance.
    assert.equal((await reconcile(storage,chainWith([published.raw],1))).paused,false);
    assert.equal((await claimRow(storage,first.id)).state,'included');
    // External spend of the name output in canonical history: reconstruction fails closed, paused.
    const external=bytesToHex(serialize({inputs:[{txid:published.txid,index:0}],outputs:[{amount:1000,script:payScript(marker)}]}));
    await assert.rejects(reconcile(storage,chainWith([published.raw,external],1)),/name_lineage_conflict/);
    assert.equal((await storage.read()).coordinator.paused,true);assert.equal((await admit(storage,second)).code,'reconciliation_required');
    await reconcile(storage,chainWith([published.raw],1));
    // Our unobserved successor loses the head to a foreign authenticated spend: conflicted, paused.
    assert.equal((await admit(storage,second)).state,'queued');
    const ours=await advance(storage,transport(broadcasts,published.raw),app,marker,second.id);assert.equal(ours.state,'broadcast_unknown');
    const foreign=await foreignSpend(published.raw,claimFor(7,'Foreign'));
    const mismatch=await reconcile(storage,chainWith([published.raw,foreign.raw],1));
    assert.equal(mismatch.paused,true);assert.equal(mismatch.head,foreign.txid+':0');
    const conflicted=await claimRow(storage,second.id);
    assert.equal(conflicted.state,'conflicted');assert.equal(conflicted.raw,ours.raw);assert.equal(conflicted.attempts,ours.attempts);
    assert.equal((await advance(storage,forbidden,app,marker,second.id)).state,'conflicted');
    assert.equal((await storage.rpc('admit',{...same,id:'c'.repeat(64),moves:first.moves-1})).code,'reconciliation_required');
    assert.equal(broadcasts.length,2);
  }finally{await db.close();}
});

test('D6: interleaved admission/preparation and a lost begin keep one unconfirmed spend across disk restart',async()=>{
  const directory=mkdtempSync(new URL('./.postgres-d6-',import.meta.url));
  let {db,storage}=await setup(directory);const claims=[4,5,6,8].map(number=>claimFor(number,'Player'+number)),broadcasts=[];
  try {
    await reconcile(storage,chainWith([],1));
    assert((await Promise.all(claims.map(claim=>admit(storage,claim)))).every(row=>row.state==='queued'));
    const raced=await Promise.all(claims.slice(0,3).map(claim=>advance(storage,transport(broadcasts),app,marker,claim.id)));
    const winners=raced.filter(row=>row.state==='broadcast_unknown');
    assert.equal(winners.length,1);assert.equal(raced.filter(row=>row.code==='signer_busy').length,2);assert.equal(broadcasts.length,1);
    await reconcile(storage,chainWith([winners[0].raw],1));
    const [pendingA,pendingB]=claims.filter(claim=>claim.id!==winners[0].id&&claim.id!==claims[3].id);
    // Lost begin response: the non-expiring barrier holds without raw bytes.
    const lossy={read:storage.read,rpc:async(operation,payload)=>{const result=await storage.rpc(operation,payload);if(operation==='begin')throw Error('lost response');return result;}};
    await assert.rejects(advance(lossy,transport(broadcasts,winners[0].raw),app,marker,pendingA.id),/lost response/);
    assert.equal((await claimRow(storage,pendingA.id)).state,'signing_started');
    await db.close();({db,storage}=await setup.reopen(directory));
    // After restart and reconciliation, the ambiguous barrier still blocks every successor.
    const state=await reconcile(storage,chainWith([winners[0].raw],2));
    assert.equal(state.paused,false);assert.equal(state.active,pendingA.id);
    assert.equal((await claimRow(storage,pendingA.id)).state,'signing_started');assert.equal((await claimRow(storage,pendingA.id)).raw,null);
    assert.equal((await advance(storage,transport(broadcasts,winners[0].raw),app,marker,pendingA.id)).state,'signing_started');
    assert.equal((await advance(storage,transport(broadcasts,winners[0].raw),app,marker,pendingB.id)).code,'signer_busy');
    await db.exec('update public.hd1_coordinator set active=null;');
    const {coordinator}=await storage.read();
    assert.equal((await storage.rpc('prepare',{id:pendingB.id,owner:'takeover',revision:coordinator.revision,...(await transport([],winners[0].raw).prepare())})).code,'signer_busy');
    assert.equal(broadcasts.length,1);assert.equal((await claimRow(storage,winners[0].id)).state,'included');
  }finally{await db.close();rmSync(directory,{recursive:true,force:true});}
});
/** Reopen a disk-backed database without reapplying migrations (process restart). */
setup.reopen=async directory=>{const db=new PGlite(directory);return {db,storage:connect(db)};};

test('D6 migration upgrades an existing 001 installation additively and pauses until authenticated rebuild',async()=>{
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  try {
    await db.exec(migrations('002'));
    const head=parseTransaction(history.transactions.at(-1).raw).txid;
    await db.exec(`update public.hd1_coordinator set paused=false,epoch=2900,revision=7;
      insert into public.hd1_receipts values('legacy','legacy-tx','02'||repeat('1',64),'Legacy','wings',2900,130,1,1,0,0,'receipt');
      insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision,raw,txid,prepared,attempts)
        values(repeat('a',64),'signed','02'||repeat('2',64),'Signed','wings',2900,120,1,'broadcast_unknown',0,'00',repeat('b',64),'{"operation":"update","inputs":[{"txid":"${head}","index":0}]}',2),
        (repeat('c',64),'unsigned','02'||repeat('3',64),'Queued','wings',2900,121,1,'queued',0,null,null,null,0);`);
    await db.exec(migrations().slice(migrations('002').length));
    const coordinator=(await db.query('select paused,revision from public.hd1_coordinator')).rows[0];
    assert.equal(coordinator.paused,true);assert.equal(Number(coordinator.revision),8);
    const kept=(await db.query('select id,state,raw,attempts from public.hd1_claims order by id')).rows;
    assert.deepEqual(kept.map(row=>[row.state,row.raw,row.attempts]),[['broadcast_unknown','00',2],['queued',null,0]]);
    assert.equal((await db.query('select count(*)::integer as n from public.hd1_receipts')).rows[0].n,1);
    const index=(await db.query("select indexdef from pg_indexes where indexname='hd1_active_claim'")).rows[0].indexdef;
    assert.doesNotMatch(index,/included/);assert.match(index,/queued/);assert.match(index,/signing_started/);assert.match(index,/broadcast_unknown/);
    const storage=connect(db);
    assert.equal((await storage.rpc('rebuild',{revision:7,epoch:2900,head:null,snapshot:{receipts:[],pending:[]}})).code,'stale_state');
    assert.equal((await db.query('select count(*)::integer as n from public.hd1_receipts')).rows[0].n,1);
    assert.equal((await storage.rpc('admit',{id:'f'.repeat(64),bytes:'x',player:'02'+'4'.repeat(64),nickname:'New',layout:'wings',epoch:2900,moves:100,points:1})).code,'reconciliation_required');
    await db.exec('set role service_role;');assert.equal((await storage.read()).claims.length,2);
    await db.exec('reset role;set role anon;');await assert.rejects(storage.read(),/permission denied/);await db.exec('reset role;');
    // Rebuild under D6 rules: the outstanding exact spend of the current head survives and blocks successors.
    const rebuilt=await reconcile(storage,chainWith([],1));
    // A synthetic derived-only row is discarded; authenticated history, not this table, is authority.
    assert.equal(rebuilt.paused,false);assert.equal((await claimRow(storage,'a'.repeat(64))).state,'broadcast_unknown');
    assert.equal((await claimRow(storage,'a'.repeat(64))).raw,'00');
    assert.equal((await db.query("select count(*)::integer as n from public.hd1_receipts where id='legacy'")).rows[0].n,0);
  }finally{await db.close();}
});

test('D6: reconstructed history without a journal retains a durable reorg barrier until identical lineage returns',async()=>{
  const {db,storage}=await setup();
  try {
    await reconcile(storage,chainWith([],1));
    const removed=await reconcile(storage,{history:async()=>({...history,transactions:history.transactions.slice(0,1),headers:history.headers.slice(0,4)})});
    assert.equal(removed.paused,true);
    assert.equal(removed.snapshot.reorgedLineage[0].raw,history.transactions[1].raw);
    assert.equal((await admit(storage,claimFor(4,'New'))).code,'reconciliation_required');
    // Repeated rebuild/restart-style reads cannot forget the removed operation.
    const repeated=await reconcile(connect(db),{history:async()=>({...history,transactions:history.transactions.slice(0,1),headers:history.headers.slice(0,5)})});
    assert.equal(repeated.paused,true);assert.equal((await storage.read()).claims.length,0);
    assert.equal((await reconcile(storage,chainWith([],3))).paused,false);
  }finally{await db.close();}
});

test('D6: actual inclusion week, not provisional claim week, reserves the current-week queue slot',async()=>{
  const {db,storage}=await setup();
  try {
    await reconcile(storage,chainWith([],1));
    await db.exec("insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,actual_epoch,moves,points,state,evaluation_revision,raw,txid,confirmations) values(repeat('a',64),'old week','02'||repeat('1',64),'Weekly','wings',2899,2900,120,1,'included',0,'00',repeat('b',64),1)");
    const result=await storage.rpc('admit',{id:'c'.repeat(64),bytes:'improved',player:'02'+'1'.repeat(64),nickname:'Weekly',layout:'wings',epoch:2900,moves:119,points:1});
    assert.equal(result.code,'queue_full');
    assert.equal((await storage.read()).claims.length,1);
  }finally{await db.close();}
});

test('all eleven ranked layouts roundtrip both signatures and pass Worker verification; three practice layouts remain excluded',async()=>{
  const checked=[],practice=[];
  for(const path of paths) {
    const unsigned={p:'hd1',w:2900,l:path.l,b:path.b,n:'Layouts',m:path.m};
    const player=signPlayer(unsigned,secret(1)),receipt=signApp(player,secret(2));
    assert.deepEqual(parseCanonical(canonical(player,7),7),player);
    assert.deepEqual(parseCanonical(canonical(receipt,8),8),receipt);
    assert.equal(recover('player',canonical(unsigned,6),player.s),bytesToHex(secp256k1.getPublicKey(secret(1))));
    assert.equal(recover('app',canonical(player,7),receipt.a),bytesToHex(secp256k1.getPublicKey(secret(2))));
    const storage={rpc:async(operation,payload)=>operation==='rate'?{code:'ok'}:{...payload,state:'queued'}};
    const response=await handleApi(new Request('https://game.test/api/score',{method:'POST',headers:{origin:'https://game.test','cf-connecting-ip':'192.0.2.1','content-type':'application/json','idempotency-key':receiptId(player)},body:canonical(player,7)}),
      {storage,available:true,rateSecret:'public-nonfunded-fixture-hmac-key-01'});
    const body=await response.json();
    if(CATALOG[path.l].practice) {assert.equal(response.status,422);assert.equal(body.code,'practice_layout');practice.push(path.l);}
    else {assert.equal(response.status,202,path.l);assert.equal(body.derived_moves,path.optimum);checked.push(path.l);}
  }
  assert.equal(checked.length,11);assert.equal(practice.length,3);assert(checked.includes('fayaa_rain2'));
  for(const layout of ['rain-2','é','a'.repeat(17)])assert.throws(()=>signPlayer({p:'hd1',w:2900,l:layout,b:paths[0].b,n:'Layouts',m:paths[0].m},secret(1)),/malformed/);
  const unknown=signPlayer({p:'hd1',w:2900,l:'unknown2',b:paths[0].b,n:'Layouts',m:paths[0].m},secret(1));
  assert.throws(()=>verifyClaim(canonical(unknown,7),receiptId(unknown)),/invalid_replay/);
});
