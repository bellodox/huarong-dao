import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
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

/** Exercise the real SQL migration and operational RPC, never hosted storage. */
async function setup() {
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  const storage={rpc:async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value};
  storage.read=()=>storage.rpc('read');return {db,storage};
}
/** Fixture histories stand in for independently authenticated canonical observations. */
function source(confirmations) {return {history:async()=>({...history,headers:history.headers.slice(0,2+confirmations)})};}
/** A different player has a legitimate next update after the fixture lineage. */
function nextClaim() {
  const path=paths.find(row=>row.l==='wings');
  const claim=signPlayer({p:'hd1',w:2900,l:path.l,b:path.b,n:'NextPlayer',m:path.m},secret(4));
  return verifyClaim(canonical(claim,7),receiptId(claim));
}
/** Prepare a full-script update spending the actual reconstructed name output. */
function transport(broadcasts) {
  const previousRaw=history.transactions.at(-1).raw,previous=parseTransaction(previousRaw);
  const head=previous.txid+':0';
  return {prepare:async()=>({epoch:2900,head,prepared:{operation:'update',fee:40000,markerAmount:10000,nameAmount:previous.outputs[0].amount-60000,
    inputs:[{txid:previous.txid,index:0,amount:previous.outputs[0].amount,script:bytesToHex(previous.outputs[0].script),previousRaw}]}}),
    validate:async()=>true,lookup:async()=>null,broadcast:async raw=>{broadcasts.push(raw);throw Error('fixture timeout');}};
}

test('no local journal: reconstructed five-confirmation receipt durably pauses admission, six safely resumes',async()=>{
  const {db,storage}=await setup();const verified=nextClaim(),broadcasts=[];
  try {
    const rebuilt=await reconcile(storage,source(5));
    assert.equal(rebuilt.snapshot.pending.length,1);assert.equal(rebuilt.snapshot.pending[0].confirmations,5);
    assert.equal((await storage.read()).claims.length,0);assert.equal(rebuilt.active,null);
    assert.equal(rebuilt.paused,true);
    assert.equal((await admit(storage,verified)).code,'reconciliation_required');
    assert.equal((await advance(storage,transport(broadcasts),secret(2),secp256k1.getPublicKey(secret(3)),verified.id)).code,'not_found');
    assert.equal(broadcasts.length,0);
    const resumed=await reconcile(storage,source(6));assert.equal(resumed.paused,false);assert.equal(resumed.snapshot.pending.length,0);
    assert.equal((await admit(storage,verified)).state,'queued');
    assert.equal((await advance(storage,transport(broadcasts),secret(2),secp256k1.getPublicKey(secret(3)),verified.id)).state,'broadcast_unknown');
    assert.equal(broadcasts.length,1);assert.equal((await storage.read()).coordinator.generation,1);
  }finally{await db.close();}
});

test('reconstructed pending lineage blocks queued preparation and an existing unsigned signing lease',async()=>{
  for(const leased of [false,true]) {
    const {db,storage}=await setup();const verified=nextClaim(),broadcasts=[],chain=transport(broadcasts);
    try {
      await reconcile(storage,source(6));await admit(storage,verified);
      const observed=await chain.prepare();let lease;
      if(leased) {
        const {coordinator}=await storage.read();
        lease=await storage.rpc('prepare',{id:verified.id,owner:'fixture',revision:coordinator.revision,...observed});
        assert.equal(lease.state,'unsigned_preparing');
      }
      await reconcile(storage,source(5));
      // Defense at both boundaries relies on durable reconstructed state, not local ownership.
      await db.exec('update public.hd1_coordinator set paused=false;');
      const {coordinator}=await storage.read();
      const result=leased?await storage.rpc('begin',{id:verified.id,owner:lease.owner,generation:lease.generation,revision:coordinator.revision,...observed}):
        await advance(storage,chain,secret(2),secp256k1.getPublicKey(secret(3)),verified.id);
      assert.notEqual(result.state,'signing_started');assert.equal(result.code,'reconciliation_required');
      assert.equal(broadcasts.length,0);assert.equal((await storage.read()).claims[0].raw,null);
    }finally{await db.close();}
  }
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
