import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSignedClaim,exportIdentity } from '../leaderboard/client.js';
import { base58check,parseCanonical,canonical,recover } from '../leaderboard/receipt.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
function store() {const data=new Map();return {data,getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};}
test('walletless default, consent-only identity and canonical evidence signing; withdrawal no sign',()=>{
  const storage=store(),evidence={...playerClaim,assisted:false};
  assert.throws(()=>createSignedClaim(evidence,'Player',2900,{storage}));assert.equal(storage.data.size,0);
  const signed=createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true});
  assert.match(signed.id,/^[a-f0-9]{64}$/);assert.equal(storage.data.size,1);
  const identity=exportIdentity(storage);
  const second=createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true});
  assert.equal(second.id,signed.id);assert.equal(exportIdentity(storage),identity);
  assert(!signed.bytes.includes('wif'));assert.throws(()=>createSignedClaim({...evidence,assisted:true},'Player',2900,{storage,consented:()=>true}));
});
test('legacy uncompressed mainnet WIF is retained byte-for-byte; failed storage no signature',()=>{
  const storage=store(),secret=Uint8Array.from([...Array(31).fill(0),1]);
  const original=JSON.stringify({wif:base58check(Uint8Array.from([78,...secret]))});
  storage.setItem('huarong_rod_identity_v1',original);
  const signed=createSignedClaim(playerClaim,'Player',2900,{storage,consented:()=>true});
  const claim=parseCanonical(signed.bytes,7),{s,...unsigned}=claim;
  assert.equal(recover('player',canonical(unsigned,6),s),'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  assert.equal(exportIdentity(storage),original);
  assert.throws(()=>createSignedClaim(playerClaim,'Player',2900,{storage:{getItem:()=>null,setItem:()=>{}},consented:()=>true}),/identity_save_failed/);
});
