import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { processSessionRequest,tokenHash } from '../leaderboard/session.js';
import { CATALOG,ALPHABET,DIRECTIONS,SHAPES,positions,step } from '../leaderboard/profile.js';

const ENDPOINT='https://example.test';
const ANCHOR={height:135790,hash:'a'.repeat(64)};
const SOLUTION='VObifnTKKBcckkZgMXXKSCddklYYggiiDIIRhiCmZFMMDmmaaYfIQhmBOOHbfLQQBaaeeFMMfYUnnjjCZZddUgjD';
function makeTrace(){
  let state=positions(CATALOG.rear_guard.board);
  return [...SOLUTION].map((symbol,i)=>{
    const action=ALPHABET.indexOf(symbol),piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const p=state[piece],[width,height]=SHAPES[piece];
    const x0=(p%4)*1000+width*500,y0=Math.floor(p/4)*1000+height*500;
    state=step(state,symbol);
    return [1,i*30,x0,y0,x0+dx*400,y0+dy*400];
  });
}
const TRACE=makeTrace();
function request(path,body){return new Request(ENDPOINT+path,{method:'POST',headers:{
  'Content-Type':'application/json','Origin':ENDPOINT,'cf-connecting-ip':'198.51.100.7'
},body:JSON.stringify(body)});}
const packet=(t,seq,token,head,moves,trace)=>({id:t.id,layout:'rear_guard',seq,token,head,
  nonce:t.nonce,rulesDigest:t.rulesDigest,layoutSeed:t.layoutSeed,sessionSeed:t.sessionSeed,
  rodAnchor:t.rodAnchor,moves,trace});

test('actual PostgreSQL: seeded checkpoints seal once, admission consumes witness, exact retries survive',async()=>{
  const db=new PGlite();
  try{
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(migrations(null)); // Unlike the 001-009 fixtures, exercise migration 010.
    await db.query(`update public.hd1_coordinator set paused=false,epoch=10,
      snapshot=jsonb_build_object('hash',$1::text,'height',$2::bigint,'stale',false)
      where singleton`,[ANCHOR.hash,ANCHOR.height]);
    const sql=async(name,operation,payload={})=>(await db.query(
      `select public.${name}($1,$2::jsonb) as value`,[operation,JSON.stringify(payload)]
    )).rows[0].value;
    const storage={session:(op,p)=>sql('hd_session_rpc',op,p)};
    const env={storage,available:true,rateSecret:'x'.repeat(64),rodAnchor:ANCHOR};
    const started=await processSessionRequest(request('/api/session/start',{layout:'rear_guard'}),env);
    assert.equal(started.status,200);
    const t=await started.json();let token=t.token,head=t.head;
    for(let n=1;n<=2;n++){
      const res=await processSessionRequest(request('/api/session/checkpoint',
        packet(t,n-1,token,head,SOLUTION.slice(0,n*40),TRACE.slice(0,n*40))),env);
      assert.equal(res.status,200);
      const state=await res.json();token=state.token;head=state.head;
    }
    const finished=await processSessionRequest(request('/api/session/finish',
      packet(t,2,token,head,SOLUTION,TRACE)),env);
    assert.equal(finished.status,200);
    const witness=await finished.json();
    const expectedDuration=Math.round((TRACE.at(-1)[1]-TRACE[0][1])/100);
    const sealedTime=(await db.query('select duration_ds from public.hd_ranked_sessions where id=$1::uuid',[t.id])).rows[0];
    assert.equal(sealedTime.duration_ds,expectedDuration,'the finish RPC persists telemetry-derived time');
    const session={id:witness.id,proof_hash:await tokenHash(witness.proof),
      session_seed:witness.sessionSeed,layout_seed:witness.layoutSeed,
      rules_digest:witness.rulesDigest,nonce:witness.nonce,head:witness.head,
      input_digest:witness.inputDigest,rod_block_hash:witness.rodAnchor.hash,
      rod_block_height:witness.rodAnchor.height};
    const payload={id:'e'.repeat(64),bytes:'fixture-claim-e',player:'02'+'1'.repeat(64),
      nickname:'Player',layout:'rear_guard',epoch:10,moves:SOLUTION.length,points:800,
      profile:'hd2',move_path:SOLUTION,session};
    assert.equal((await sql('hd1_rpc','admit',{...payload,session:null})).code,'session_required');
    assert.equal((await sql('hd1_rpc','admit',{...payload,move_path:SOLUTION+'A'})).code,'invalid_session');
    const admitted=await sql('hd1_rpc','admit',payload);
    assert.equal(admitted.state,'queued');
    assert.equal((await sql('hd1_rpc','admit',{...payload,session:null})).state,'queued',
      'same exact claim bytes remain retriable');
    assert.equal((await sql('hd1_rpc','admit',{...payload,id:'f'.repeat(64),bytes:'fixture-claim-f'})).code,
      'invalid_session','one witness cannot admit a different claim');
    const row=(await db.query('select state,receipt_id from public.hd_ranked_sessions where id=$1::uuid',[t.id])).rows[0];
    assert.equal(row.state,'admitted');assert.equal(row.receipt_id,payload.id);
    const stored=(await db.query('select duration_ds,moves,points from public.hd1_claims where id=$1',[payload.id])).rows[0];
    assert.equal(stored.duration_ds,expectedDuration,'admission durably copies accepted time');
    assert.equal(stored.moves,SOLUTION.length);assert.equal(stored.points,payload.points);
  }finally{await db.close();}
});
