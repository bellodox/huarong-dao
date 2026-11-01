import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authenticateRetirement } from '../leaderboard/recovery.js';
import { buildTransaction,signTransaction,payScript,parseTransaction,serialize } from '../leaderboard/chain.js';
import { canonical,receiptId,signApp,bytesToHex } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { createSpaceXpanseProvider } from '../leaderboard/provider.js';
import { chainFixture,config,appKey,markerKey,secret,txidOf,payment } from './publisher-fixture.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
/** Build only non-funded local transactions with genuine signatures and recomputed headers. */
async function fixture() {
  const chain=chainFixture(),provider=createSpaceXpanseProvider({...config,anchor:{height:100,hash:chain.blocks[0].hash},fetch:chain.fetch,allowUnprovenNameAbsence:true});
  const claim=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim)),{prepared}=await provider.prepare({...claim,bytes:claim.text});
  const receipt=signApp(playerClaim,secret),signed=signTransaction(buildTransaction(prepared,receipt,appKey,markerKey),secret);
  const original={...claim,bytes:claim.text,nickname:playerClaim.n,layout:playerClaim.l,epoch:playerClaim.w,prepared,...signed,receipt:canonical(receipt,8)};
  const source=prepared.inputs[0];
  const conflict=signTransaction({version:2,inputs:[{txid:source.txid,index:source.index,previousScript:payScript(appKey)}],
    outputs:[{amount:source.amount-70000,script:payScript(appKey)}],locktime:0},secret);
  chain.mine([conflict.raw]);for(let i=0;i<5;i++)chain.mine();
  const document={headers:await provider.primitives.fetchHeaders(100,chain.tip().height)};
  return {chain,api:provider.primitives,original,conflict,document};
}
test('retirement authenticates different exact raw, shared input, signature, merkle/header ancestry and six confirmations',async()=>{
  const f=await fixture(),result=await authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document);
  assert.equal(result.confirmations,6);assert.equal(result.proof.raw,f.conflict.raw);
  assert.equal(result.proof.input.txid,f.original.prepared.inputs[0].txid);
  assert.deepEqual(await authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document,result.proof),result);
});
test('original itself, forged journal, missing conflict and five confirmations never retire',async()=>{
  const f=await fixture();
  await assert.rejects(authenticateRetirement(f.api,f.original,f.original.txid,config,f.document),/recovery_invalid_conflict/);
  await assert.rejects(authenticateRetirement(f.api,{...f.original,txid:'ab'.repeat(32)},f.conflict.txid,config,f.document));
  await assert.rejects(authenticateRetirement(f.api,f.original,'cd'.repeat(32),config,f.document),/recovery_frozen/);
  f.chain.blocks.pop();
  await assert.rejects(authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document),/recovery_frozen/);
});
test('fake conflict association, invalid signature, missing ancestry and changed saved proof fail closed',async()=>{
  const f=await fixture(),result=await authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document);
  await assert.rejects(authenticateRetirement(f.api,f.original,f.conflict.txid,config,{headers:[]}),/recovery_proof_reorg/);
  await assert.rejects(authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document,{...result.proof,block_hash:'ab'.repeat(32)}),/recovery_proof_reorg/);
  const tx=parseTransaction(f.conflict.raw),api={...f.api,transaction:async()=>({raw:f.original.prepared.inputs[0].previousRaw,height:114,blockHash:f.chain.blocks[14].hash})};
  await assert.rejects(authenticateRetirement(api,f.original,f.conflict.txid,config,f.document),/recovery_invalid_conflict/);
  tx.inputs[0].script[5]^=1;
  const raw=bytesToHex(serialize(tx)),badId=txidOf(raw);
  const forged={...f.api,transaction:async()=>({raw,height:114,blockHash:f.chain.blocks[14].hash})};
  await assert.rejects(authenticateRetirement(forged,f.original,badId,config,f.document),/invalid_transaction_signature/);
  const unrelated=payment('unrelated'),unrelatedId=txidOf(unrelated);
  await assert.rejects(authenticateRetirement({...f.api,transaction:async()=>({raw:unrelated,height:114,blockHash:f.chain.blocks[14].hash})},
    f.original,unrelatedId,config,f.document),/recovery_no_shared_input/);
});
test('external wallet conflict with non-final sequence is authenticated using its actual legacy preimage',async()=>{
  const f=await fixture(),source=f.original.prepared.inputs[0];
  const signed=signTransaction({version:1,inputs:[{txid:source.txid,index:source.index,sequence:0xfffffffd,previousScript:payScript(appKey)}],
    outputs:[{amount:source.amount-70000,script:payScript(appKey)}],locktime:1},secret);
  f.chain.mine([signed.raw]);for(let i=0;i<5;i++)f.chain.mine();
  const document={headers:await f.api.fetchHeaders(100,f.chain.tip().height)};
  const result=await authenticateRetirement(f.api,f.original,signed.txid,config,document);
  assert.equal(result.proof.raw,signed.raw);
});
test('tampered merkle/header and linked fork not matching the acquired tip cannot retire',async()=>{
  const f=await fixture();
  const route=f.chain.route;
  f.chain.route=(path,init)=>{
    const value=route(path,init);
    if(path.startsWith('/range/'))return value.map((block,index)=>index===value.length-1?{...block,merkleroot:'ab'.repeat(32)}:block);
    return value;
  };
  await assert.rejects(authenticateRetirement(f.api,f.original,f.conflict.txid,config,f.document),/invalid_header/);
  f.chain.route=route;
  const headers=await f.api.fetchHeaders(114,119);
  await assert.rejects(authenticateRetirement({...f.api,fetchHeaders:async()=>headers.map((header,index)=>index===headers.length-1?{...header,hash:'cd'.repeat(32)}:header)},
    f.original,f.conflict.txid,config,f.document),/recovery_proof_reorg/);
});
