import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture,chainFixture,config } from './publisher-fixture.js';
import { publicStatus } from '../leaderboard/storage.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { admit } from '../leaderboard/issuer.js';
import { canonical,receiptId } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { readFileSync } from 'node:fs';

test('independent PostgreSQL status matrix preserves journals and has no authority side effects',async()=>{
 const {db,storage}=await databaseFixture();
 try {
  const claim={id:'independent',state:'queued',attempts:0,generation:1,raw:null};
  const scope={id:'independent-scope',claims:[claim.id],transactions:0,max_transactions:2,broadcasts:0,fee_units:0,max_fee_units:100000,reservations:{[claim.id]:{generation:1}}};
  const cases=[
   ['unrestricted queued',{},null,true,null],
   ['unrestricted attempt cap',{attempts:4},null,false,'retry_exhausted'],
   ['finite available',{},scope,true,null],
   ['outside finite claims',{}, {...scope,claims:[]},false,'claim_outside_scope'],
   ['finite transaction cap',{}, {...scope,transactions:2},false,'transaction_budget_exhausted'],
   ['finite fee cap',{}, {...scope,fee_units:100000},false,'spend_budget_exhausted'],
   ['signed reserved available',{state:'broadcast_unknown',raw:'00'},scope,true,null],
   ['signed broadcast cap',{state:'broadcast_pending',raw:'00'}, {...scope,broadcasts:2},false,'broadcast_budget_exhausted'],
   ['signed wrong generation',{state:'broadcast_unknown',raw:'00',generation:2},scope,false,'claim_outside_scope'],
   ['included never retried',{state:'included',raw:'00'}, {...scope,broadcasts:2},false,null],
   ['ambiguous signing never retried',{state:'signing_started'},scope,false,null],
   ['confirmed never retried',{state:'confirmed'},null,false,null],
   ['finite attempt cap',{attempts:4},scope,false,'retry_exhausted']
  ];
  for(const [label,patch,authority,retryable,code] of cases){
   await db.query('update public.hd1_runtime set finite_scope=$1::jsonb',[authority===null?null:JSON.stringify(authority)]);
   const before=await storage.rpc('operational');
   const row={...claim,...patch};
   const result=(await db.query('select public.hd1_public_status(jsonb_populate_record(null::public.hd1_claims,$1::jsonb)) as value',[JSON.stringify(row)])).rows[0].value;
   assert.equal(result.publication_retryable,retryable,label);
   assert.equal(result.retry_code,code,label);
   assert.equal(result.retryable,publicStatus(row,authority).retryable,label);
   assert.equal(result.publication_retryable,publicStatus(row,authority).publication_retryable,label+' JS/SQL parity');
   assert.equal(result.retry_code,publicStatus(row,authority).retry_code,label+' JS/SQL code parity');
   assert.equal(Object.hasOwn(result,'raw'),false,label+' raw leakage');
   assert.equal(Object.hasOwn(result,'reservations'),false,label+' authority leakage');
   assert.deepEqual(await storage.rpc('operational'),before,label+' must not mutate operational state');
  }
  const properties=(await db.query("select provolatile,prosecdef from pg_proc where oid='public.hd1_public_status(public.hd1_claims)'::regprocedure")).rows[0];
  assert.equal(properties.provolatile,'s');assert.equal(properties.prosecdef,true);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.hd1_public_status(public.hd1_claims)','EXECUTE') as allowed",[role])).rows[0].allowed,false,role+' cannot invoke private helper');
  console.log('13 PostgreSQL semantic cases, read-only snapshots, JS parity and 3 role restrictions verified');
 }finally{await db.close();}
});

test('independent exhausted scope cannot broadcast again or widen its counters',async()=>{
 const {db,storage}=await databaseFixture(),chain=chainFixture();
 try{
  await runPublisher(storage,config,{fetch:chain.fetch});
  const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
  await admit(storage,verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)));
  const scope=await storage.rpc('finite_open',{id:crypto.randomUUID(),name:'g/huarong-lb',max_transactions:1,max_fee_units:100000,max_new_locked_units:1000600});
  await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id});
  const before=(await db.query('select finite_scope from public.hd1_runtime where singleton')).rows[0].finite_scope,count=chain.broadcasts.length;
  assert.equal(count,1);
  const result=await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id});
  assert.equal(chain.broadcasts.length,count,'exhausted scope must not send a second raw');
  assert.deepEqual((await db.query('select finite_scope from public.hd1_runtime where singleton')).rows[0].finite_scope,before,'scope counters and reservations immutable');
  console.log('Exhausted repeat result',JSON.stringify(result));
 }finally{await db.close();}
});
