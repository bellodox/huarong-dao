import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {CATALOG,ALPHABET,DIRECTIONS,SHAPES,positions,step,replay} from '../leaderboard/profile.js';
import {
  SessionFailure,verifySessionEvidence,processSessionRequest,tokenHash,traceDigest,
  readSessionBody,layoutSeed,sessionSeed,hashParts
} from '../leaderboard/session.js';

const SOLUTION='VObifnTKKBcckkZgMXXKSCddklYYggiiDIIRhiCmZFMMDmmaaYfIQhmBOOHbfLQQBaaeeFMMfYUnnjjCZZddUgjD';
const HEX=/^[a-f0-9]{64}$/;
const ROD_ANCHOR=Object.freeze({height:135790,hash:'a'.repeat(64)});
const endpoint='https://example.test';
function traceSolution(moves=SOLUTION){
  let state=positions(CATALOG.rear_guard.board);
  return [...moves].map((symbol,i)=>{
    const action=ALPHABET.indexOf(symbol),piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const p=state[piece],width=SHAPES[piece][0],height=SHAPES[piece][1];
    const x0=(p%4)*1000+Math.floor(width*500),y0=Math.floor(p/4)*1000+Math.floor(height*500);
    state=step(state,symbol);
    return [1,i*30,x0,y0,x0+dx*400,y0+dy*400];
  });
}
const TRACE=traceSolution();
const request=(path,data,headers={})=>new Request(endpoint+path,{method:'POST',
  headers:{'Content-Type':'application/json','Origin':endpoint,'cf-connecting-ip':'198.51.100.7',...headers},
  body:JSON.stringify(data)});
const environment=storage=>({storage,available:true,rateSecret:'x'.repeat(64),rodAnchor:storage.anchor??ROD_ANCHOR});

// SQL row-lock/CAS semantics emulation: not a substitute for a live PGlite/Postgres test.
class SessionStore {
  rows=new Map();
  anchor=ROD_ANCHOR;
  async session(op,p){
    if(op==='start'){
      assert.match(p.rules_digest,HEX);assert.match(p.layout_seed,HEX);assert.match(p.session_seed,HEX);
      assert.match(p.nonce,HEX);assert.match(p.trace_digest,HEX);assert.match(p.chain_head,HEX);
      if(p.rod_block_hash!==this.anchor.hash||p.rod_block_height!==this.anchor.height)
        return {code:'anchor_changed'};
      this.rows.set(p.id,{...p,state:'active',seq:0,moves:'',receipt_id:null});
      return {code:'ok'};
    }
    if(op==='advance'){
      const s=this.rows.get(p.id);
      if(!s||s.state!=='active')return {code:'session_expired'};
      if(s.layout!==p.layout||s.seq!==p.seq||s.token_hash!==p.token_hash||
        s.nonce!==p.nonce||s.rules_digest!==p.rules_digest||s.layout_seed!==p.layout_seed||
        s.session_seed!==p.session_seed||s.rod_block_hash!==p.rod_block_hash||
        s.rod_block_height!==p.rod_block_height||
        s.chain_head!==p.previous_head||s.trace_digest!==p.prior_trace_digest||
        !p.moves.startsWith(s.moves))return {code:'session_conflict'};
      if(p.final){
        if(s.seq<2)return {code:'checkpoints_missing'};
        s.state='sealed';s.proof_hash=p.proof_hash;s.input_digest=p.input_digest;
      }else{
        if(p.moves.length!==40*(s.seq+1))return {code:'checkpoint_boundary'};
        s.seq++;s.token_hash=p.next_hash;
      }
      s.moves=p.moves;s.trace_digest=p.trace_digest;s.chain_head=p.next_head;
      return {code:'ok'};
    }
    return {code:'unsupported_operation'};
  }
}
async function begin(storage){
  const response=await processSessionRequest(request('/api/session/start',{layout:'rear_guard'}),environment(storage));
  assert.equal(response.status,200);
  const ticket=await response.json();
  assert.equal(ticket.board,CATALOG.rear_guard.board);
  return ticket;
}
const packet=(t,seq,token,head,moves,trace,extras={})=>({
  id:t.id,layout:'rear_guard',seq,token,nonce:t.nonce,head,
  rulesDigest:t.rulesDigest,layoutSeed:t.layoutSeed,sessionSeed:t.sessionSeed,
  rodAnchor:t.rodAnchor,moves,trace,...extras
});
async function checkpoints(store,t){
  let token=t.token,head=t.head;
  for(let k=1;k<=2;k++){
    const args=packet(t,k-1,token,head,SOLUTION.slice(0,k*40),TRACE.slice(0,k*40));
    const resp=await processSessionRequest(request('/api/session/checkpoint',args),environment(store));
    assert.equal(resp.status,200);
    const body=await resp.json();token=body.token;head=body.head;
    assert.match(head,HEX);
  }
  return {token,head};
}

test('known 88-move solution replays independently and accepts gesture-consistent evidence',()=>{
  assert.equal(replay({p:'hd2',l:'rear_guard',b:CATALOG.rear_guard.board,m:SOLUTION}).moves,88);
  assert.deepEqual(verifySessionEvidence('rear_guard',SOLUTION,TRACE,{complete:true}),{moves:88,solved:true});
});

test('layout seed is deterministic, rules-bound, and session seed changes with nonce and identity',async()=>{
  const a=await layoutSeed('rear_guard'),b=await layoutSeed('rear_guard'),c=await layoutSeed('wings');
  assert.deepEqual(a,b);assert.notEqual(a.layoutSeed,c.layoutSeed);
  assert.match(a.rulesDigest,HEX);assert.match(a.layoutSeed,HEX);
  const id='8de303a8-8123-4fac-bccf-103593344ccd',nonce='1'.repeat(64),nonce2='2'.repeat(64);
  const s=await sessionSeed('rear_guard',id,nonce,ROD_ANCHOR),
    s2=await sessionSeed('rear_guard',id,nonce2,ROD_ANCHOR),
    s3=await sessionSeed('rear_guard','5fe303a8-8123-4fac-bccf-103593344ccd',nonce,ROD_ANCHOR);
  const otherBlock=await sessionSeed('rear_guard',id,nonce,{height:ROD_ANCHOR.height+1,hash:'b'.repeat(64)});
  assert.notEqual(s.sessionSeed,otherBlock.sessionSeed);
  assert.equal(s.layoutSeed,a.layoutSeed);assert.notEqual(s.sessionSeed,s2.sessionSeed);
  assert.notEqual(s.sessionSeed,s3.sessionSeed);
  assert.equal(s.sessionSeed,await hashParts('session',a.layoutSeed,id,nonce,ROD_ANCHOR.height,ROD_ANCHOR.hash));
});

test('a valid session uses two ordered checkpoints and one sealed immutable witness',async()=>{
  const store=new SessionStore(),t=await begin(store);
  const expected=await sessionSeed('rear_guard',t.id,t.nonce,t.rodAnchor);
  assert.deepEqual(t.rodAnchor,ROD_ANCHOR);
  assert.equal(expected.sessionSeed,t.sessionSeed);assert.equal(expected.layoutSeed,t.layoutSeed);
  const first=packet(t,0,t.token,t.head,SOLUTION.slice(0,40),TRACE.slice(0,40));
  const response=await processSessionRequest(request('/api/session/checkpoint',first),environment(store));
  assert.equal(response.status,200);
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',first),environment(store)),
    e=>e.code==='session_conflict');
  const b=await response.json();
  const second=packet(t,1,b.token,b.head,SOLUTION.slice(0,80),TRACE.slice(0,80));
  const step2=await processSessionRequest(request('/api/session/checkpoint',second),environment(store));
  assert.equal(step2.status,200);
  const token2=await step2.json();
  const fin=packet(t,2,token2.token,token2.head,SOLUTION,TRACE);
  const finished=await processSessionRequest(request('/api/session/finish',fin),environment(store));
  assert.equal(finished.status,200);
  const witness=await finished.json();
  assert.match(witness.inputDigest,HEX);assert.match(witness.head,HEX);
  assert.match(await tokenHash(witness.proof),HEX);
  assert.notEqual(witness.head,token2.head);
  assert.equal(store.rows.get(t.id).trace,undefined,'raw pointer traces are not stored in SQL');
  assert.equal(store.rows.get(t.id).state,'sealed');
  assert.equal(store.rows.get(t.id).input_digest,witness.inputDigest);
  await assert.rejects(()=>processSessionRequest(request('/api/session/finish',fin),environment(store)),
    e=>e.code==='session_expired');
});

test('modified initial seed, nonce, and chain head fail before session state changes',async()=>{
  const store=new SessionStore(),t=await begin(store);
  const basic=packet(t,0,t.token,t.head,SOLUTION.slice(0,40),TRACE.slice(0,40));
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',
    {...basic,layoutSeed:'0'.repeat(64)}),environment(store)),e=>e.code==='seed_mismatch');
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',
    {...basic,nonce:'0'.repeat(64)}),environment(store)),e=>e.code==='seed_mismatch');
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',
    {...basic,head:'0'.repeat(64)}),environment(store)),e=>e.code==='session_conflict');
  assert.equal(store.rows.get(t.id).seq,0);
});

test('altering an already checkpointed telemetry prefix is rejected by stored commitment',async()=>{
  const store=new SessionStore(),t=await begin(store);
  const one=await processSessionRequest(request('/api/session/checkpoint',packet(t,0,t.token,t.head,
    SOLUTION.slice(0,40),TRACE.slice(0,40))),environment(store));
  const next=await one.json();
  const altered=TRACE.slice(0,80).map(row=>row.slice());
  altered[0][1]+=1; // still nondecreasing, but earlier accepted trace no longer matches
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',packet(t,1,next.token,next.head,
    SOLUTION.slice(0,80),altered)),environment(store)),e=>e.code==='session_conflict');
  assert.equal(store.rows.get(t.id).seq,1);
});

test('direct final submission without checkpoints is not admissible',async()=>{
  const store=new SessionStore(),t=await begin(store);
  await assert.rejects(()=>processSessionRequest(request('/api/session/finish',packet(t,0,t.token,t.head,
    SOLUTION,TRACE)),environment(store)),e=>e.code==='checkpoints_missing');
});

test('illegal inputs, impossible pointers, missing trace, and practice layouts are rejected',()=>{
  const fake=structuredClone(TRACE);fake[0][0]=0;
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION,fake),e=>e.code==='telemetry_tap_mismatch');
  fake[0]=[1,0,-700,-700,-300,-700];
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION,fake),e=>e.code==='telemetry_tile_mismatch');
  const negative=structuredClone(TRACE);negative[1][1]=-1;
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION,negative),e=>e.code==='invalid_telemetry');
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION,TRACE.slice(1)),e=>e.code==='invalid_telemetry');
  assert.throws(()=>verifySessionEvidence('training',SOLUTION,TRACE),e=>e.code==='invalid_layout');
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION.slice(0,80),TRACE.slice(0,80),{complete:true}),
    e=>e.code==='unsolved');
});

test('client witness agrees with relay-derived initial seed, checkpoints, final trace and head',async()=>{
  const store=new SessionStore();
  // Minimal fake browser hosting the unchanged pointer API of the ranked-session module.
  const window={};
  class PointerEvent {constructor(type,x,y){this.type=type;this.clientX=x;this.clientY=y;this.isTrusted=true;}}
  const fetch=async (url,init)=>{
    try{return await processSessionRequest(new Request(endpoint+url,{
      method:'POST',headers:{'Content-Type':'application/json','Origin':endpoint,
        'cf-connecting-ip':'198.51.100.7'},body:init.body}),environment(store));}
    catch(err){return Response.json({code:err.code||'unexpected'},{status:err.status||422});}
  };
  const source=fs.readFileSync(new URL('../public/ranked-session.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{window,crypto:webcrypto,performance,fetch,PointerEvent,AbortSignal,TextEncoder,Uint8Array,
    Array,Object,Number,Math,Promise,Error,JSON});
  await window.hdRanked.start('rear_guard',CATALOG.rear_guard.board);
  for(let i=0;i<SOLUTION.length;i++){
    const tr=TRACE[i],x0=tr[2]/10,y0=tr[3]/10,x1=tr[4]/10,y1=tr[5]/10;
    window.hdRanked.record(SOLUTION[i],{kind:1,event:new PointerEvent('pointermove',x1,y1),
      rect:{left:0,top:0,width:400,height:500},x0,y0,x1,y1});
  }
  const witness=await window.hdRanked.finish(SOLUTION);
  assert.ok(witness,'browser must receive a sealed witness');
  assert.match(witness.inputDigest,HEX);
  assert.equal(store.rows.get(witness.id).chain_head,witness.head);
  assert.equal(store.rows.get(witness.id).session_seed,witness.sessionSeed);
  assert.equal(store.rows.get(witness.id).rod_block_hash,ROD_ANCHOR.hash);
  assert.equal(store.rows.get(witness.id).rod_block_height,ROD_ANCHOR.height);
  assert.equal(witness.rodAnchor.hash,ROD_ANCHOR.hash);
  assert.equal(store.rows.get(witness.id).state,'sealed');
});

test('malformed and oversized requests are rejected before session creation',async()=>{
  await assert.rejects(()=>readSessionBody(new Request(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})),
    e=>e.code==='malformed');
  const store=new SessionStore();
  await assert.rejects(()=>processSessionRequest(request('/api/session/start',{layout:'training'}),environment(store)),
    e=>e.code==='invalid_layout');
  assert.equal(store.rows.size,0);
});

test('SQL admission requires a sealed, single-use seeded session and exact replayed move path',()=>{
  const sql=fs.readFileSync(new URL('../supabase/migrations/010_ranked_sessions.sql',import.meta.url),'utf8');
  for(const guard of [
    "s.state<>'sealed'", "s.moves is distinct from payload->>'move_path'",
    "payload->>'profile' is distinct from 'hd2'", "s.proof_hash is distinct from proof->>'proof_hash'",
    "s.session_seed is distinct from proof->>'session_seed'",
    "s.rod_block_hash is distinct from proof->>'rod_block_hash'",
    "s.rod_block_height is distinct from (proof->>'rod_block_height')::bigint",
    'alter function public.hd1_public(text,jsonb) rename to hd1_public_v10',
    "s.layout_seed is distinct from proof->>'layout_seed'",
    "s.rules_digest is distinct from proof->>'rules_digest'",
    "s.chain_head is distinct from proof->>'head'",
    "s.input_digest is distinct from proof->>'input_digest'",
    "where id=sid for update", "set state='admitted',receipt_id=payload->>'id'"
  ]) assert.ok(sql.includes(guard),`Missing SQL admission guard: ${guard}`);
  assert.ok(sql.includes('trace_digest text not null'));
  assert.ok(!sql.includes('trace jsonb not null'),'Raw pointer traces must not be persisted');
});


test('start rejects missing chain observation and mismatched SQL snapshot',async()=>{
  const store=new SessionStore();
  await assert.rejects(()=>processSessionRequest(request('/api/session/start',{layout:'rear_guard'}),
    {...environment(store),rodAnchor:null}),e=>e.code==='rod_anchor_unavailable');
  assert.equal(store.rows.size,0);
  store.anchor={height:135791,hash:'b'.repeat(64)};
  await assert.rejects(()=>processSessionRequest(request('/api/session/start',{layout:'rear_guard'}),
    {...environment(store),rodAnchor:ROD_ANCHOR}),e=>e.code==='anchor_changed');
  assert.equal(store.rows.size,0);
});

test('block hash and block height cannot be changed after session issuance',async()=>{
  const store=new SessionStore(),t=await begin(store);
  const first=packet(t,0,t.token,t.head,SOLUTION.slice(0,40),TRACE.slice(0,40));
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',
    {...first,rodAnchor:{hash:'c'.repeat(64),height:t.rodAnchor.height}}),environment(store)),
    e=>e.code==='seed_mismatch');
  await assert.rejects(()=>processSessionRequest(request('/api/session/checkpoint',
    {...first,rodAnchor:{hash:t.rodAnchor.hash,height:t.rodAnchor.height+1}}),environment(store)),
    e=>e.code==='seed_mismatch');
  assert.equal(store.rows.get(t.id).seq,0);
});
