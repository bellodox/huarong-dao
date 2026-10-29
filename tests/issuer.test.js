import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { receiptId,canonical } from '../leaderboard/receipt.js';
import { admit,advance } from '../leaderboard/issuer.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const transactions=JSON.parse(readFileSync(new URL('./fixtures/transactions.json',import.meta.url)));
const secret=Uint8Array.from([...Array(31).fill(0),2]);
const marker=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),3]));
async function setup() {
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  await db.exec('update public.hd1_coordinator set paused=false,epoch=2900;');
  const storage={rpc:async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value};
  storage.read=()=>storage.rpc('read');
  const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));
  await admit(storage,verified);
  return {db,storage,id:verified.id};
}
test('SQL + signer + mock transport: persistence precedes fetch, timeout retries same bytes after restart',async()=>{
  const {db,storage,id}=await setup();const broadcasts=[];
  const chain={prepare:async()=>({epoch:2900,head:null,prepared:transactions.prepared}),validate:async()=>true,
    lookup:async()=>null,broadcast:async raw=>{
      const row=(await storage.read()).claims[0];assert.equal(row.raw,raw);assert.equal(row.state,'broadcast_unknown');
      broadcasts.push(raw);throw Error('ambiguous timeout');
    }};
  try {
    const result=await advance(storage,chain,secret,marker,id);assert.equal(result.state,'broadcast_unknown');
    assert.equal(broadcasts.length,1);
    assert.equal((await advance(storage,chain,secret,marker,id)).code,'retry_later');
    await db.exec("update public.hd1_claims set retry_at=clock_timestamp()-interval '1 second';");
    const restarted={...storage,read:()=>storage.rpc('read')};
    await advance(restarted,chain,secret,marker,id);
    assert.equal(broadcasts.length,2);assert.equal(broadcasts[0],broadcasts[1]);
    assert.equal((await storage.read()).coordinator.generation,1);
  }finally{await db.close();}
});
test('hostile fees and unauthenticated amounts never enter preparation or signing_started',async()=>{
  for(const change of [{fee:100001},{fee:100000},{inputs:transactions.prepared.inputs.map(input=>({...input,amount:input.amount-1}))},{inputs:transactions.prepared.inputs.map(({previousRaw,...input})=>input)}]) {
    const {db,storage,id}=await setup();let validated=false;
    const chain={prepare:async()=>({epoch:2900,head:null,prepared:{...transactions.prepared,...change}}),validate:async()=>{validated=true;return true;}};
    try {
      await assert.rejects(advance(storage,chain,secret,marker,id));
      const state=await storage.read();assert.equal(state.claims[0].state,'queued');
      assert.equal(state.coordinator.generation,0);assert.equal(validated,false);
    }finally{await db.close();}
  }
});
test('lost begin/finalize response and database outage never authorize a second signing/fetch',async()=>{
  for(const failure of ['begin','finalize']) {
    const {db,storage,id}=await setup();let fetched=0;
    const baseRpc=storage.rpc;
    const lossy={read:storage.read,rpc:async(op,payload)=>{
      const result=await baseRpc(op,payload);if(op===failure)throw Error('lost response');return result;
    }};
    const chain={prepare:async()=>({epoch:2900,head:null,prepared:transactions.prepared}),validate:async()=>true,
      lookup:async()=>null,broadcast:async()=>{fetched++;}};
    try {
      await assert.rejects(advance(lossy,chain,secret,marker,id),/lost response/);assert.equal(fetched,0);
      const row=(await storage.read()).claims[0];assert.equal(row.state,failure==='begin'?'signing_started':'signed_persisted');
      if(failure==='begin')assert.equal((await advance(storage,chain,secret,marker,id)).state,'signing_started');
      assert.equal((await storage.read()).coordinator.generation,1);
    }finally{await db.close();}
  }
});
