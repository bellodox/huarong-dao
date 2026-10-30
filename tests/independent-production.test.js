import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { canonical,receiptId,signPlayer } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit } from '../leaderboard/issuer.js';
import { bindings,chainFixture,databaseFixture } from './publisher-fixture.js';

// Independent execution of bundled production wiring, real migrations and provider envelopes.
test('independent production cron only: durable registration, successor/final6 and restart catch-up beyond 20k',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture(),original=globalThis.fetch;
  const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
  const env={...bindings};let posted=0;
  globalThis.fetch=async(url,init={})=>{
    if(String(url).startsWith(bindings.SUPABASE_URL+'/')){
      const {operation,payload}=JSON.parse(init.body);
      return Response.json(await (String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
    }
    if(String(url).endsWith('/broadcast')){
      const raw=new URLSearchParams(init.body).get('raw'),state=await storage.read();
      assert(state.claims.some(row=>row.raw===raw&&row.attempts>0),'broadcast must follow committed exact raw and attempt');posted++;
    }
    return chain.fetch(url,init);
  };
  const tick=async()=>{const tasks=[];worker.scheduled({},env,{waitUntil:p=>tasks.push(p)});assert.equal(tasks.length,1);await Promise.all(tasks);};
  try{
    await tick();await admit(storage,verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)));
    await Promise.all([tick(),tick()]);
    let state=await storage.read(),first=state.claims[0];assert.equal(posted,1);assert.equal(first.state,'broadcast_unknown');
    const {s,...unsigned}=playerClaim;
    const second=signPlayer({...unsigned,n:'CronSecond'},Uint8Array.from([...Array(31).fill(0),9]));
    await admit(storage,verifyClaim(canonical(second,7),receiptId(second)));await tick();assert.equal(posted,1,'zero confirmations block successor');
    chain.mine([first.raw]);await tick();state=await storage.read();
    assert.equal(state.claims.find(row=>row.id===first.id).state,'included');assert.equal(posted,2,'one canonical inclusion permits successor');
    const successor=state.claims.find(row=>row.id!==first.id);chain.mine([successor.raw]);
    for(let i=0;i<5;i++)chain.mine();await tick();state=await storage.read();
    assert(state.claims.every(row=>row.state==='confirmed'),'both claims finalize at six');
    assert.equal(state.coordinator.snapshot.receipts.length,2);assert.equal(posted,2);
    const anchor=(await storage.rpc('operational')).config.anchor.height;
    for(let i=0;i<20030;i++)chain.mine();
    let caught=false,ticks=0;
    for(;ticks<310;ticks++){
      await tick();const runtime=await storage.rpc('operational');
      if(runtime.document.checkpoint?.height===chain.tip().height-60&&chain.tip().height-anchor>20000){caught=true;break;}
    }
    assert(caught,'durable fresh-provider ticks must catch up beyond the original 20,000-block span, allowing the designed 60-block checkpoint lag');
    await tick();state=await storage.read();const runtime=await storage.rpc('operational');
    assert.equal(runtime.ready,true);assert.equal(posted,2,'catch-up must never re-sign or rebroadcast finalized claims');
    assert.equal(state.claims.find(row=>row.id===first.id).raw,first.raw);
    assert.equal(state.coordinator.snapshot.receipts.length,2);
    console.log('INDEPENDENT production cron: 2 finalized claims, 2 broadcasts, catch-up ticks',ticks+1,'span',chain.tip().height-anchor);
  }finally{globalThis.fetch=original;await db.close();}
});
