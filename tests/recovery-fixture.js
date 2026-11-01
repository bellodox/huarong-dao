import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { runPublisher } from '../leaderboard/publisher.js';
import { canonical,receiptId,signPlayer } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit } from '../leaderboard/issuer.js';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';
import { payScript,signTransaction } from '../leaderboard/chain.js';
import { databaseFixture,connectDatabase,chainFixture,config,appKey,secret } from './publisher-fixture.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
/** Genuine rejected low-fee transaction in a consumed finite scope, no live resources. */
export async function failedFixture(directory,{upgrade=false,update=false}={}) {
  let db,storage;
  if(upgrade) {
    db=new PGlite(directory);await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(migrations('007_failed_transaction_recovery.sql'));storage=connectDatabase(db);
  }else ({db,storage}=await databaseFixture(directory));
  const chain=chainFixture();
  await runPublisher(storage,config,{fetch:chain.fetch});
  let verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));await admit(storage,verified);
  if(update) {
    await runPublisher(storage,config,{fetch:chain.fetch});
    chain.mine([(await storage.read()).claims[0].raw]);await runPublisher(storage,config,{fetch:chain.fetch});
    const {s,...unsigned}=playerClaim,other=signPlayer({...unsigned,n:'Other'},Uint8Array.from([...Array(31).fill(0),4]));
    verified=verifyClaim(canonical(other,7),receiptId(other));await admit(storage,verified);chain.broadcasts=[];
  }
  const runtime=await storage.rpc('operational');
  const provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},fetch:chain.fetch,
    bootstrap:update?{txid:runtime.bootstrap}:null,allowUnprovenNameAbsence:true,feePerByte:20});
  const {prepared}=await provider.prepare({bytes:verified.text});
  const scope=await storage.rpc('finite_open',{id:crypto.randomUUID(),name:'g/huarong-lb',max_transactions:1,
    max_fee_units:prepared.fee,max_new_locked_units:update?600:1000600});
  chain.hooks.any=path=>path==='/broadcast'?Response.json({error:{code:-26,message:'min relay fee not met'},result:null}):null;
  const failed=await runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id,providerOptions:{feePerByte:20}});
  if(failed.diagnostic!=='broadcast_fee_rejected')throw Error('fixture_not_rejected');
  const original=(await storage.read()).claims.find(row=>row.id===verified.id),source=original.prepared.inputs.find(input=>input.script.length===50);
  const conflict=signTransaction({version:2,inputs:[{txid:source.txid,index:source.index,previousScript:payScript(appKey)}],
    outputs:[{amount:source.amount-70000,script:payScript(appKey)}],locktime:0},secret);
  const envelope={id:crypto.randomUUID(),scope_id:scope.id,claim_id:original.id,original_txid:original.txid,
    generation:original.generation,conflict_txid:conflict.txid,consent_claim:original.id,name:'g/huarong-lb',
    max_signings:1,max_broadcasts:2,max_fee_units:100000,max_new_locked_units:update?600:1000600};
  const install=()=>storage.rpc('recovery_install',envelope);
  const tick=()=>runPublisher(storage,config,{fetch:chain.fetch,scope:scope.id,recovery:envelope.id});
  const invalidate=()=>{chain.mine([conflict.raw]);for(let i=0;i<5;i++)chain.mine();chain.hooks.any=null;};
  return {db,storage,chain,scope,original,conflict,envelope,install,tick,invalidate};
}
