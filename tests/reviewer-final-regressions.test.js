import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { databaseFixture,chainFixture,config,bindings } from './publisher-fixture.js';
import { publicStatus } from '../leaderboard/storage.js';
import { handleApi } from '../leaderboard/relay-entry.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { admit } from '../leaderboard/issuer.js';
import { canonical,receiptId } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { liveAcceptance } from './live-publisher-acceptance.js';

const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const text=canonical(playerClaim,7),id=receiptId(playerClaim);

/** Exercise duplicate admission and GET against the same authoritative SQL projection. */
test('HTTP duplicate POST and GET retain identical exhausted and out-of-scope status',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});
    await admit(storage,verifyClaim(text,id));
    const scope=await storage.rpc('finite_open',{id:crypto.randomUUID(),name:'g/huarong-lb',max_transactions:1,
      max_fee_units:100000,max_new_locked_units:1000600});
    await db.query("update public.hd1_claims set state='broadcast_unknown',raw='00',attempts=1,generation=1 where id=$1",[id]);
    for(const [reason,claims] of [['broadcast_budget_exhausted',[id]],['claim_outside_scope',[]]]) {
      await db.query('update public.hd1_runtime set finite_scope=$1::jsonb',[JSON.stringify({...scope,claims,broadcasts:1,
        reservations:{[id]:{generation:1}}})]);
      const before=await storage.rpc('operational');
      const options={storage,available:true,rateSecret:bindings.HD1_RATE_HMAC_KEY};
      const get=await handleApi(new Request('https://game.test/api/submissions/'+id),options);
      const post=await handleApi(new Request('https://game.test/api/score',{method:'POST',headers:{
        Origin:'https://game.test','Content-Type':'application/json','Idempotency-Key':id,'cf-connecting-ip':'127.0.0.1'
      },body:text}),options);
      assert.equal(get.status,200);assert.equal(post.status,202);
      const expected=await get.json();assert.equal(expected.publication_retryable,false);assert.equal(expected.retry_code,reason);
      assert.deepEqual(await post.json(),expected,reason+' complete receipt response parity');
      assert.deepEqual(await storage.rpc('operational'),before,'status/admission must preserve finite scope');
    }
  }finally{await db.close();}
});

/** Verify lower-bound lock eligibility only; exact spend authority remains in the publisher/SQL fences. */
test('SQL and JS status deny zero/subminimum remaining locks and preserve exact600/reserved raw',async()=>{
  const {db,storage}=await databaseFixture();
  try {
    const claim={id:'lock-budget',state:'queued',attempts:0,generation:1,raw:null};
    for(const remaining of [0,599,600])for(const raw of [null,'00']) {
      const row={...claim,raw,state:raw?'broadcast_unknown':'queued'};
      const scope={claims:[claim.id],transactions:0,max_transactions:1,broadcasts:0,fee_units:0,max_fee_units:100000,
        new_locked_units:600,max_new_locked_units:600+remaining,reservations:{[claim.id]:{generation:1}}};
      await db.query('update public.hd1_runtime set finite_scope=$1::jsonb',[JSON.stringify(scope)]);
      const before=await storage.rpc('operational');
      const sql=(await db.query('select public.hd1_public_status(jsonb_populate_record(null::public.hd1_claims,$1::jsonb)) as value',
        [JSON.stringify(row)])).rows[0].value;
      const eligible=!!raw||remaining>=600,reason=eligible?null:'spend_budget_exhausted';
      for(const [label,status] of [['SQL',sql],['JS',publicStatus(row,scope)]]) {
        assert.equal(status.publication_retryable,eligible,`${label} remaining=${remaining} raw=${raw}`);
        assert.equal(status.retry_code,reason,label);
      }
      assert.deepEqual(await storage.rpc('operational'),before);
    }
  }finally{await db.close();}
});

/** Run the actual acceptance transport/publisher path using non-funded in-memory fixtures only. */
test('acceptance preserves allowlisted fee diagnostic beside legacy outcomes without extra broadcast',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture();let attempts=0;
  try {
    await runPublisher(storage,config,{fetch:chain.fetch});await admit(storage,verifyClaim(text,id));
    chain.hooks.any=path=>{
      if(path!=='/broadcast')return;
      attempts++;return Response.json({error:{code:-26,message:'min relay fee not met PRIVATE arbitrary payload'},result:null});
    };
    const fetcher=async(url,init)=>{
      if(String(url).startsWith(bindings.SUPABASE_URL)) {
        const {operation,payload}=JSON.parse(init.body);
        return Response.json(await(String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
      }
      return chain.fetch(url,init);
    };
    const result=await liveAcceptance(bindings,['--publish','--name=g/huarong-lb','--max-broadcasts=1',
      '--max-fee-units=100000','--max-new-locked-units=1000600'],{fetch:fetcher});
    assert.deepEqual(result.outcomes,['broadcast_unknown']);
    assert.deepEqual(result.diagnostics,[{tick:1,code:'broadcast_unknown',diagnostic:'broadcast_fee_rejected'}]);
    assert.equal(attempts,1);assert.equal(result.broadcasts,1);
    assert.equal((await storage.read()).claims[0].attempts,1);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|arbitrary payload|min relay fee not met/);
  }finally{await db.close();}
});
