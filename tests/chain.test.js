import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { buildTransaction,signTransaction,sighash,payScript,nameScript,address,hash256,serialize,parseTransaction,parseName,verifyInput,estimatedSignedBytes,checkTransactionFee,FEE_POLICY } from '../leaderboard/chain.js';
import { bytesToHex,canonical } from '../leaderboard/receipt.js';
const {receipt,longReceipt}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const secret=Uint8Array.from([...Array(31).fill(0),2]), key=secp256k1.getPublicKey(secret);
const markerKey=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),3]));
const previousRaw=bytesToHex(serialize({inputs:[{txid:'1'.repeat(64),index:0}],outputs:[{amount:10000000,script:payScript(key)}]}));
const prepared={operation:'register',fee:40000,markerAmount:10000,nameAmount:5000000,inputs:[{txid:parseTransaction(previousRaw).txid,index:0,amount:10000000,script:bytesToHex(payScript(key)),previousRaw}]};
test('legacy register/update fixtures use complete name scripts and low-S SIGHASH_ALL',()=>{
  const registerTx=buildTransaction(prepared,longReceipt,key,markerKey), register=signTransaction(registerTx,secret);
  assert.equal(register.txid,bytesToHex(hash256(serialize(registerTx)).reverse()));
  assert(register.weight<40000);assert.equal(registerTx.outputs[1].amount,10000);
  const updatePrepared={...prepared,operation:'update',nameAmount:4940000,inputs:[{txid:register.txid,index:0,amount:5000000,script:bytesToHex(registerTx.outputs[0].script),previousRaw:register.raw}]};
  const updateTx=buildTransaction(updatePrepared,receipt,key,markerKey), update=signTransaction(updateTx,secret);
  const script=updateTx.inputs[0].script;
  // Last byte of the first pushed vector is the explicit SIGHASH_ALL flag.
  const der=script.slice(1,script[0]);assert.equal(script[script[0]],1);
  assert(secp256k1.verify(der,sighash(updateTx,0,registerTx.outputs[0].script),key,{prehash:false,format:'der',lowS:true}));
  assert(!secp256k1.verify(der,sighash(updateTx,0,payScript(key)),key,{prehash:false,format:'der',lowS:true}));
  const decoded=parseTransaction(update.raw);
  assert(verifyInput(decoded,0,registerTx.outputs[0].script,key));
  assert.equal(parseName(decoded.outputs[0].script).value,canonical(receipt,8));
  assert.equal(parseName(decoded.outputs[0].script).name,'g/huarong-lb');
  assert.throws(()=>parseTransaction(update.raw+'00'));
  assert.throws(()=>parseTransaction(update.raw.slice(0,-2)));
  assert(registerTx.outputs[0].script.length>1800);
  assert.match(address(key),/^R/);
  writeFileSync(new URL('./fixtures/transactions.json',import.meta.url),JSON.stringify({sourceRevision:'248f1af050579a369af527288f5773a021ae8492',appKey:bytesToHex(key),markerKey:bytesToHex(markerKey),address:address(key),prepared,updatePrepared,register,update,receipt:canonical(receipt,8),longReceipt:canonical(longReceipt,8)},null,2));
});
test('authenticated prevouts and experimental fee ceilings reject hostile adapter metadata',()=>{
  for(const change of [{amount:9999999},{script:'00'},{previousRaw:undefined},{txid:'f'.repeat(64)},{index:1},{sequence:0xfffffffd}]) {
    assert.throws(()=>buildTransaction({...prepared,inputs:[{...prepared.inputs[0],...change}]},receipt,key,markerKey));
  }
  assert.throws(()=>buildTransaction({...prepared,fee:100001},receipt,key,markerKey),/fee/);
  assert.throws(()=>buildTransaction({...prepared,fee:100000},receipt,key,markerKey),/fee/);
});
test('signed estimator uses exact compact sizes and bounds DER savings and omitted change',()=>{
  for(const length of [75,76,252,253,255,256,65535,65536]) {
    const tx={inputs:[{txid:'1'.repeat(64),index:0}],outputs:[{amount:1,script:new Uint8Array(length)}]};
    assert.equal(estimatedSignedBytes(tx),serialize(tx,[new Uint8Array(108)]).length);
    assert.equal(estimatedSignedBytes(tx)-serialize(tx,[new Uint8Array()]).length,108);
  }
  const tx=buildTransaction(prepared,receipt,key,markerKey),estimated=estimatedSignedBytes(tx);
  assert.equal(checkTransactionFee(tx,estimated*100,100),estimated);
  assert.throws(()=>checkTransactionFee(tx,estimated*100+1),/excessive_fee_rate/);
  assert.throws(()=>checkTransactionFee(tx,estimated*100-1,100),/relay_fee_insufficient/);
  for(const floor of [null,NaN,Infinity,-1,1.1])assert.throws(()=>checkTransactionFee(tx,1,floor),/relay_fee_unavailable/);
  assert.throws(()=>checkTransactionFee(tx,1,101),/relay_fee_policy_incompatible/);
  const noChange={...tx,outputs:tx.outputs.slice(0,2)},maximum=estimatedSignedBytes(noChange)*100+3999;
  assert.doesNotThrow(()=>checkTransactionFee(noChange,maximum));
  assert.throws(()=>checkTransactionFee(noChange,maximum+1),/excessive_fee_rate/);
  assert.throws(()=>checkTransactionFee(tx,FEE_POLICY.maximum+1),/excessive_fee/);
});
test('single and multiple compressed inputs stay below signed estimate despite DER variability',()=>{
  const lengths=new Set();
  for(let seed=0;seed<24;seed++) {
    const funding=bytesToHex(serialize({inputs:[{txid:seed.toString(16).padStart(64,'0'),index:0}],outputs:[{amount:10000000,script:payScript(key)}]}));
    const input={txid:parseTransaction(funding).txid,index:0,amount:10000000,script:bytesToHex(payScript(key)),previousRaw:funding};
    const tx=buildTransaction({...prepared,inputs:[input]},receipt,key,markerKey),estimate=estimatedSignedBytes(tx);
    const signed=signTransaction(tx,secret);lengths.add(tx.inputs[0].script.length);
    assert(signed.raw.length/2<=estimate);assert(estimate-signed.raw.length/2<=4);
    if(seed===1) {
      const multi=buildTransaction({...prepared,inputs:[prepared.inputs[0],input]},receipt,key,markerKey);
      assert.equal(estimatedSignedBytes(multi)-estimate,149);
      assert(signTransaction(multi,secret).raw.length/2<=estimatedSignedBytes(multi));
    }
  }
  assert(lengths.size>1,'fixture exercises different deterministic DER lengths');
});
test('integer funds/dust, dedicated marker and reserved ownership fail closed',()=>{
  for(const bad of [{...prepared,fee:1.1},{...prepared,nameAmount:100},{...prepared,markerAmount:1},{...prepared,fee:20000000}])assert.throws(()=>buildTransaction(bad,receipt,key,markerKey));
  assert.throws(()=>buildTransaction(prepared,receipt,key,key));
  assert.throws(()=>buildTransaction({...prepared,operation:'update'},receipt,key,markerKey));
});
