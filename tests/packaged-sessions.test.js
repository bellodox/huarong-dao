import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Miniflare,Log,LogLevel,convertV4MiniflareOptions } from 'miniflare';
import { applyCompleteMigrations } from './complete-migrations-fixture.js';
import { bindings } from './publisher-fixture.js';
import { CATALOG,ALPHABET,DIRECTIONS,SHAPES,positions,step } from '../leaderboard/profile.js';

const SOLUTION='VObifnTKKBcckkZgMXXKSCddklYYggiiDIIRhiCmZFMMDmmaaYfIQhmBOOHbfLQQBaaeeFMMfYUnnjjCZZddUgjD';
const ANCHOR={height:135790,hash:'a'.repeat(64)};
/** Derive consistent synthetic gestures; these are not physical-input provenance. */
function traceSolution() {
  let state=positions(CATALOG.rear_guard.board);
  return [...SOLUTION].map((symbol,index)=>{
    const action=ALPHABET.indexOf(symbol),piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const position=state[piece],[width,height]=SHAPES[piece];
    const x=(position%4)*1000+width*500,y=Math.floor(position/4)*1000+height*500;
    state=step(state,symbol);return [1,index*230,x,y,x+dx*400,y+dy*400];
  });
}

test('packaged Worker runs SQL-backed session start/checkpoints/finish/status and fails closed on readiness',async()=>{
  const db=new PGlite(),calls=[];let runtime,capability=4;
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await applyCompleteMigrations(db);
    await db.query(`update public.hd1_coordinator set paused=false,epoch=10,
      snapshot=jsonb_build_object('hash',$1::text,'height',$2::bigint,'stale',false)`,[ANCHOR.hash,ANCHOR.height]);
    await db.exec('set role service_role;');
    runtime=new Miniflare(convertV4MiniflareOptions({
      modules:['worker.js','relay.js','tests/rod-transport-probe.worker.js'].map(path=>({
        type:'ESModule',path,contents:readFileSync(new URL('../'+path,import.meta.url),'utf8')
      })),compatibilityDate:'2026-10-23',log:new Log(LogLevel.NONE),bindings,
      outboundService:async request=>{
        const url=new URL(request.url),{operation,payload}=await request.json();
        assert.equal(url.origin,bindings.SUPABASE_URL);assert.equal(request.method,'POST');
        const name=url.pathname.split('/').at(-1);
        assert(['hd1_public','hd_session_rpc','hd_session_status'].includes(name),'unexpected publisher or provider operation');
        calls.push({name,operation,payload});
        if(name==='hd1_public') {
          assert.equal(operation,'readiness');
          return Response.json({available:true,capability_revision:capability,rod_anchor:ANCHOR});
        }
        return Response.json((await db.query(`select public.${name}($1,$2::jsonb) as result`,
          [operation,JSON.stringify(payload)])).rows[0].result);
      }
    }));
    const post=(path,body)=>runtime.dispatchFetch('https://game.test/api/session/'+path,{method:'POST',
      headers:{origin:'https://game.test','Content-Type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify(body)});
    capability=3;
    assert.equal((await post('start',{layout:'rear_guard'})).status,503);
    assert.equal(calls.filter(call=>call.name==='hd_session_rpc').length,0);
    capability=4;
    const response=await post('start',{layout:'rear_guard'});
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    const ticket=await response.json(),trace=traceSolution();let token=ticket.token,head=ticket.head;
    assert.deepEqual(ticket.rodAnchor,ANCHOR);
    const packet=(seq,length)=>({id:ticket.id,layout:'rear_guard',seq,token,head,nonce:ticket.nonce,
      rulesDigest:ticket.rulesDigest,layoutSeed:ticket.layoutSeed,sessionSeed:ticket.sessionSeed,
      rodAnchor:ticket.rodAnchor,moves:SOLUTION.slice(0,length),trace:trace.slice(0,length)});
    assert.equal((await post('finish',packet(0,88))).status,422);
    for(let seq=0;seq<2;seq++) {
      const body=packet(seq,(seq+1)*40),checkpoint=await post('checkpoint',body);
      assert.equal(checkpoint.status,200);
      assert.equal((await post('checkpoint',body)).status,409,'accepted tokens cannot replay');
      ({token,head}=await checkpoint.json());
    }
    const finished=await post('finish',packet(2,88));assert.equal(finished.status,200);
    assert.match((await finished.json()).proof,/^[A-Za-z0-9_-]{43}$/);
    const status=await runtime.dispatchFetch('https://game.test/api/session/status?id='+ticket.id);
    assert.equal(status.status,200);const item=await status.json();assert.equal(item.state,'sealed');
    for(const key of ['token','token_hash','proof','proof_hash','moves','trace','nonce','session_seed'])
      assert.equal(Object.hasOwn(item,key),false,'session status leaked '+key);
    await assert.rejects(db.query('select * from public.hd_ranked_sessions'),/permission denied/);
    await db.exec('reset role;');
    const row=(await db.query('select state,duration_ds from public.hd_ranked_sessions where id=$1',[ticket.id])).rows[0];
    assert.deepEqual(row,{state:'sealed',duration_ds:200});
    assert(calls.some(call=>call.name==='hd1_public'&&call.payload.include_anchor===true));
    assert.equal(calls.filter(call=>call.name==='hd_session_rpc'&&call.operation==='start').length,1);
  }finally {if(runtime)await runtime.dispose();await db.close();}
});
