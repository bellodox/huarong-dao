import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applyCompleteMigrations } from './complete-migrations-fixture.js';
import { CATALOG,ALPHABET,DIRECTIONS,SHAPES,positions,step,occupancy,replay,assertSubmissionMoves,PUBLIC_SUBMISSION_MAX_MOVES } from '../leaderboard/profile.js';
import { canonical,signPlayer,receiptId } from '../leaderboard/receipt.js';
import { handleApi,verifyOffline } from '../leaderboard/relay-entry.js';
import { processSessionRequest,layoutSeed } from '../leaderboard/session.js';

const paths=JSON.parse(readFileSync(new URL('./fixtures/paths.json',import.meta.url)));
const secret=Uint8Array.from([...Array(31).fill(0),1]);
const anchor={height:135790,hash:'a'.repeat(64)},origin='https://game.test';
/** Retain a solved path with legal reversible detours, respecting board parity. */
function padded(layout,moves) {
  const path=paths.find(row=>row.l===layout),state=positions(path.b);
  assert.equal((moves-path.m.length)%2,0);
  for(let action=0;action<40;action++)try {
    const symbol=ALPHABET[action],reverse=ALPHABET[(action&~3)+(action%4+2)%4];
    if(occupancy(step(step(state,symbol),reverse))===path.b)
      return {p:'hd2',w:10,l:layout,b:path.b,n:'Player',m:(symbol+reverse).repeat((moves-path.m.length)/2)+path.m};
  }catch{}
  throw Error('missing_detour');
}
/** Synthetic consistent telemetry validates replay, not human presence. */
function trace(claim) {
  let state=positions(claim.b);
  return [...claim.m].map((symbol,index)=>{
    const action=ALPHABET.indexOf(symbol),piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const position=state[piece],[width,height]=SHAPES[piece];
    const x=position%4*1000+width*500,y=Math.floor(position/4)*1000+height*500;
    state=step(state,symbol);return [1,index*30,x,y,x+dx*400,y+dy*400];
  });
}
const post=(path,body,headers={})=>new Request(origin+path,{method:'POST',headers:{origin,
  'Content-Type':'application/json','cf-connecting-ip':'192.0.2.1',...headers},body:typeof body==='string'?body:JSON.stringify(body)});

for(const [layout,moves] of [['wings',220],['fayaa_sideBySide',221]])test(`solved ${moves}-move ${layout}: separate admission and historical verification`,()=>{
  assert.equal(PUBLIC_SUBMISSION_MAX_MOVES,220);
  const claim=signPlayer(padded(layout,moves),secret),text=canonical(claim,7);
  assert.equal(replay(claim).moves,moves);
  assert.equal(verifyOffline(text).moves,moves);
  if(moves===220)assert.doesNotThrow(()=>assertSubmissionMoves('hd2',layout,moves));
  else assert.throws(()=>assertSubmissionMoves('hd2',layout,moves),/submission_move_limit/);
});

test('full SQL + HTTP: 220 seals/admitted once; solved 221 rejected before queue/session mutation; admitted 448 preserved',async()=>{
  const db=new PGlite();
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await applyCompleteMigrations(db);
    await db.query(`update public.hd1_coordinator set paused=false,epoch=10,
      snapshot=jsonb_build_object('hash',$1::text,'height',$2::bigint,'stale',false)`,[anchor.hash,anchor.height]);
    const sql=async(name,operation,payload={})=>(await db.query(`select public.${name}($1,$2::jsonb) as value`,[operation,JSON.stringify(payload)])).rows[0].value;
    let admits=0;
    const storage={session:(op,p)=>sql('hd_session_rpc',op,p),publicRead:(op,p)=>sql('hd1_public',op,p),
      rpc:(op,p)=>{if(op==='admit')admits++;return sql('hd1_rpc',op,p);}};
    const env={storage,available:true,rateSecret:'x'.repeat(64),rodAnchor:anchor};
    const signed=signPlayer(padded('wings',220),secret),telemetry=trace(signed);
    const started=await processSessionRequest(post('/api/session/start',{layout:signed.l}),env);
    const ticket=await started.json();assert.equal(ticket.maxMoves,220);
    // Admission policy must not change the pre-existing versioned rules digest.
    assert.equal(ticket.rulesDigest,(await layoutSeed(signed.l)).rulesDigest);
    let token=ticket.token,head=ticket.head,seq=0;
    const packet=(moves,observations)=>({id:ticket.id,layout:signed.l,seq,token,head,nonce:ticket.nonce,
      rulesDigest:ticket.rulesDigest,layoutSeed:ticket.layoutSeed,sessionSeed:ticket.sessionSeed,
      rodAnchor:ticket.rodAnchor,moves,trace:observations});
    for(let length=40;length<=200;length+=40){
      const response=await processSessionRequest(post('/api/session/checkpoint',packet(signed.m.slice(0,length),telemetry.slice(0,length))),env);
      assert.equal(response.status,200);({token,head,seq}=await response.json());
    }
    const before=(await db.query('select * from public.hd_ranked_sessions where id=$1',[ticket.id])).rows[0];
    for(const route of ['checkpoint','finish']) {
      const rejected=await handleApi(post('/api/session/'+route,packet(signed.m+'A',telemetry)),env);
      assert.equal(rejected.status,422);assert.equal((await rejected.json()).code,'submission_move_limit');
    }
    assert.deepEqual((await db.query('select * from public.hd_ranked_sessions where id=$1',[ticket.id])).rows[0],before);
    const finished=await processSessionRequest(post('/api/session/finish',packet(signed.m,telemetry)),env);
    assert.equal(finished.status,200);const witness=await finished.json();
    const headers={'Idempotency-Key':receiptId(signed),'X-HD-Session-Id':witness.id,'X-HD-Session-Proof':witness.proof,
      'X-HD-Session-Seed':witness.sessionSeed,'X-HD-Layout-Seed':witness.layoutSeed,'X-HD-Rules-Digest':witness.rulesDigest,
      'X-HD-Session-Nonce':witness.nonce,'X-HD-Session-Head':witness.head,'X-HD-Session-Input-Digest':witness.inputDigest,
      'X-HD-ROD-Block-Hash':anchor.hash,'X-HD-ROD-Block-Height':String(anchor.height)};
    assert.equal((await handleApi(post('/api/score',canonical(signed,7),headers),env)).status,202);
    assert.equal((await handleApi(post('/api/score',canonical(signed,7),headers),env)).status,202);
    assert.equal((await db.query('select state from public.hd_ranked_sessions where id=$1',[ticket.id])).rows[0].state,'admitted');
    const count=admits;
    for(const profile of ['hd1','hd2']) {
      const over=signPlayer({...padded('fayaa_sideBySide',221),p:profile},secret);
      const response=await handleApi(post('/api/score',canonical(over,7),{'Idempotency-Key':receiptId(over)}),env);
      assert.equal(response.status,422);assert.deepEqual(await response.json(),{code:'submission_move_limit',retryable:false});
    }
    assert.equal(admits,count,'new oversized claims must never reach admission RPC');
    const old=signPlayer(padded('wings',448),Uint8Array.from([...Array(31).fill(0),4])),id=receiptId(old),bytes=canonical(old,7);
    // Simulate a claim admitted before this policy, not a new bypass via today's admission.
    await db.query(`insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
      values($1,$2,$3,'Player','wings',10,448,$4,'queued',0)`,[id,bytes,verifyOffline(bytes).player,replay(old).points]);
    const oldBefore=(await db.query('select * from public.hd1_claims where id=$1',[id])).rows[0];
    const response=await handleApi(post('/api/score',bytes,{'Idempotency-Key':id}),env);
    assert.equal(response.status,202);assert.equal((await response.json()).derived_moves,448);
    assert.deepEqual((await db.query('select * from public.hd1_claims where id=$1',[id])).rows[0],oldBefore);
    assert.equal(verifyOffline(bytes).moves,448);
  }finally{await db.close();}
});
