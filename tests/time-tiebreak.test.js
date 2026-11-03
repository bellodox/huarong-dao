import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processSessionRequest,verifySessionEvidence } from '../leaderboard/session.js';
import { CATALOG,ALPHABET,DIRECTIONS,SHAPES,positions,step } from '../leaderboard/profile.js';

const SOLUTION='VObifnTKKBcckkZgMXXKSCddklYYggiiDIIRhiCmZFMMDmmaaYfIQhmBOOHbfLQQBaaeeFMMfYUnnjjCZZddUgjD';
const ANCHOR={height:135790,hash:'a'.repeat(64)};
function traceSolution(){
  let state=positions(CATALOG.rear_guard.board);
  return [...SOLUTION].map((symbol,i)=>{
    const action=ALPHABET.indexOf(symbol),piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const p=state[piece],[width,height]=SHAPES[piece];
    const x0=(p%4)*1000+width*500,y0=Math.floor(p/4)*1000+height*500;
    state=step(state,symbol);
    return [1,1200+i*230,x0,y0,x0+dx*400,y0+dy*400];
  });
}
const TRACE=traceSolution();
const post=(path,body)=>new Request('https://fixture.test'+path,{method:'POST',headers:{
  'Content-Type':'application/json','cf-connecting-ip':'198.51.100.2'
},body:JSON.stringify(body)});
const packet=(ticket,seq,token,head,moves,trace)=>({id:ticket.id,layout:'rear_guard',seq,token,head,
  nonce:ticket.nonce,rulesDigest:ticket.rulesDigest,layoutSeed:ticket.layoutSeed,
  sessionSeed:ticket.sessionSeed,rodAnchor:ticket.rodAnchor,moves,trace});

test('duration is computed from the existing accepted gesture trace at finish only',async()=>{
  const calls=[],storage={session:async(operation,payload)=>{calls.push({operation,payload});return {code:'ok'};}};
  const env={storage,available:true,rateSecret:'x'.repeat(64),rodAnchor:ANCHOR};
  const started=await processSessionRequest(post('/api/session/start',{layout:'rear_guard'}),env);
  assert.equal(started.status,200);
  const ticket=await started.json();let token=ticket.token,head=ticket.head;
  for(let n=1;n<=2;n++){
    const response=await processSessionRequest(post('/api/session/checkpoint',
      packet(ticket,n-1,token,head,SOLUTION.slice(0,n*40),TRACE.slice(0,n*40))),env);
    assert.equal(response.status,200);
    const next=await response.json();token=next.token;head=next.head;
  }
  const finished=await processSessionRequest(post('/api/session/finish',
    packet(ticket,2,token,head,SOLUTION,TRACE)),env);
  assert.equal(finished.status,200);
  const final=calls.at(-1).payload;
  assert.equal(final.duration_ds,200); // 87 intervals x 230 ms = 20.01 s.
  assert.equal(final.moves,SOLUTION);
  assert.equal(final.final,true);
  assert.equal(calls.filter(x=>x.payload.duration_ds!==undefined).length,1);
  assert.equal(verifySessionEvidence('rear_guard',SOLUTION,TRACE,{complete:true}).solved,true);
});

test('duration cannot bypass trace validation and no new API routes are introduced',()=>{
  const altered=TRACE.map(entry=>entry.slice());altered[1][1]=altered[0][1]-1;
  assert.throws(()=>verifySessionEvidence('rear_guard',SOLUTION,altered,{complete:true}),/invalid_telemetry/);
  const source=readFileSync(new URL('../leaderboard/session.js',import.meta.url),'utf8');
  assert.match(source,/body\.trace\.at\(-1\)\[1\]-body\.trace\[0\]\[1\]/);
  assert.doesNotMatch(source,/\/api\/session\/duration|\/api\/session\/time/);
});

test('migration only adds duration metadata, keeps strict move-based admission and hd2 unchanged',()=>{
  const migration=readFileSync(new URL('../supabase/migrations/012_layout_time_tiebreak.sql',import.meta.url),'utf8');
  assert.match(migration,/alter table public\.hd_ranked_sessions add column duration_ds/);
  assert.match(migration,/alter table public\.hd1_claims add column duration_ds/);
  assert.match(migration,/update public\.hd1_claims c set duration_ds=new\.duration_ds/);
  assert.match(migration,/moves asc,duration_ds asc nulls last/);
  assert.match(migration,/order by r\.player,r\.layout,r\.moves,r\.height/);
  assert.doesNotMatch(migration,/alter function public\.hd1_rpc|create function public\.hd1_rpc|create or replace function public\.hd1_rpc/);
  assert.doesNotMatch(migration,/alter table public\.hd1_receipts|change.*points|\bhd3\b/i);
});
