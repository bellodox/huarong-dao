import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyCompleteMigrations } from './complete-migrations-fixture.js';
import { handleApi } from '../leaderboard/relay-entry.js';

const origin='https://game.test';
const uuid='718f8d77-4158-47c8-8c04-b8a14000d14a';
const receiptId='e'.repeat(64);
const get=(path)=>new Request(origin+path);

test('session status GET is read-only, bounded, validated and does not expose session credentials',async()=>{
  const events=[];
  const storage={sessionStatus:async(op,p)=>{
    events.push({op,p});
    return op==='recent'?{sessions:[{id:uuid,state:'active',checkpoints:1,recorded_moves:40}]}:
      p.id===uuid?{id:uuid,state:'sealed',checkpoints:2,recorded_moves:88}:{code:'not_found'};
  }};
  const opts={storage,available:true};
  let response=await handleApi(get('/api/session/status'),opts);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{sessions:[{id:uuid,state:'active',checkpoints:1,recorded_moves:40}]});
  response=await handleApi(get('/api/session/status?id='+uuid),opts);
  assert.equal(response.status,200);
  assert.equal((await response.json()).state,'sealed');
  response=await handleApi(get('/api/session/status?id=not-an-id'),opts);
  assert.equal(response.status,400);
  response=await handleApi(get('/api/session/status?id='+crypto.randomUUID()),opts);
  assert.equal(response.status,404);
  assert.equal((await handleApi(get('/api/session/status?limit=1000'),opts)).status,400);
  assert.equal((await handleApi(get('/api/session/status?id='+uuid+'&id='+uuid),opts)).status,400);
  assert.equal((await handleApi(new Request(origin+'/api/session/status',{method:'POST'}),opts)).status,405);
  assert.equal((await handleApi(get('/api/session/status'),{})).status,503);
  assert.deepEqual(events.map(e=>e.op),['recent','get','get']);
  assert.deepEqual(events[1].p,{id:uuid});
});

test('SQL session status includes score and publication state, excludes proofs, and denies public DB roles',async()=>{
  const db=new PGlite();
  try{
    await db.exec('create role anon;create role authenticated;create role service_role;');
    // Fresh schema fixture covers 001-012; subsequent operational scripts require live publisher state.
    await applyCompleteMigrations(db);
    const values={id:uuid,receipt:receiptId};
    await db.query(`insert into public.hd_ranked_sessions
      (id,layout,state,seq,moves,nonce,rules_digest,layout_seed,session_seed,
       rod_block_hash,rod_block_height,trace_digest,chain_head,token_hash,
       proof_hash,input_digest,receipt_id,expires_at)
      values($1,'rear_guard','admitted',2,$2,$3,$3,$3,$3,$3,1234,$3,$3,$3,$3,$3,$4,
      now()+interval '72 hours')`,[values.id,'X'.repeat(88),'a'.repeat(64),values.receipt]);
    await db.query(`insert into public.hd1_claims
      (id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision,txid,confirmations)
      values($1,'{}',$2,'PLAYER','rear_guard',3000,88,810,'confirmed',1,$3,6)`,
      [values.receipt,'02'+'b'.repeat(64),'c'.repeat(64)]);
    const recent=(await db.query("select public.hd_session_status('recent','{}') as result")).rows[0].result;
    assert.equal(recent.sessions.length,1);
    const item=recent.sessions[0];
    assert.equal(item.state,'admitted');
    assert.equal(item.score_moves,88);
    assert.equal(item.score_points,810);
    assert.equal(item.nickname,'PLAYER');
    assert.equal(item.confirmations,6);
    assert.equal(item.checkpoints,2);
    for(const key of ['token_hash','proof_hash','nonce','moves','input_digest','trace_digest','chain_head','session_seed','bytes','player','raw'])
      assert.equal(Object.hasOwn(item,key),false,'private field leaked: '+key);
    const one=(await db.query("select public.hd_session_status('get',$1::jsonb) as result",[JSON.stringify({id:uuid})])).rows[0].result;
    assert.deepEqual(one,item);
    const absent=(await db.query("select public.hd_session_status('get',$1::jsonb) as result",[JSON.stringify({id:crypto.randomUUID()})])).rows[0].result;
    assert.deepEqual(absent,{code:'not_found'});
    const roles=(await db.query(`select
      has_function_privilege('anon','public.hd_session_status(text,jsonb)','EXECUTE') as anon,
      has_function_privilege('authenticated','public.hd_session_status(text,jsonb)','EXECUTE') as authenticated,
      has_function_privilege('service_role','public.hd_session_status(text,jsonb)','EXECUTE') as service`)).rows[0];
    assert.deepEqual(roles,{anon:false,authenticated:false,service:true});
  }finally{await db.close();}
});
