import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSignedClaim,exportIdentity } from '../leaderboard/client.js';
import { RANKED_PROFILE,RANKED_MAX_MOVES,positions,step,ALPHABET,occupancy } from '../leaderboard/profile.js';
import { base58check,parseCanonical,canonical,recover } from '../leaderboard/receipt.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
function store() {const data=new Map();return {data,getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};}
test('walletless default, consent-only identity and canonical evidence signing; withdrawal no sign',()=>{
  const storage=store(),evidence={...playerClaim,assisted:false};
  assert.throws(()=>createSignedClaim(evidence,'Player',2900,{storage}));assert.equal(storage.data.size,0);
  const signed=createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true});
  assert.match(signed.id,/^[a-f0-9]{64}$/);assert.equal(storage.data.size,1);
  assert.equal(parseCanonical(signed.bytes,7).p,RANKED_PROFILE);
  const identity=exportIdentity(storage);
  const second=createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true});
  assert.equal(second.id,signed.id);assert.equal(exportIdentity(storage),identity);
  assert(!signed.bytes.includes('wif'));assert.throws(()=>createSignedClaim({...evidence,assisted:true},'Player',2900,{storage,consented:()=>true}));
});
const paths=JSON.parse(readFileSync(new URL('./fixtures/paths.json',import.meta.url)));
/** Produce actual complete legal paths, with reversible detours before the solution. */
function padded(path,moves) {
  const state=positions(path.b);
  let pair;
  for(let action=0;action<40;action++)try {
    const reverse=ALPHABET[(action&~3)+(action%4+2)%4];
    if(occupancy(step(step(state,ALPHABET[action]),reverse))===path.b){pair=ALPHABET[action]+reverse;break;}
  }catch{}
  assert(pair);assert.equal((moves-path.m.length)%2,0);
  return {...path,m:pair.repeat((moves-path.m.length)/2)+path.m};
}
for(const [layout,maximum] of Object.entries(RANKED_MAX_MOVES))test(`client hd2 ${layout} inclusive policy and no identity for overlimit`,()=>{
  const path=paths.find(path=>path.l===layout),reachable=maximum-(maximum-path.m.length)%2;
  const evidence=padded(path,reachable),original=JSON.stringify(evidence),storage=store();
  const signed=createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true});
  assert.equal(parseCanonical(signed.bytes,7).m,evidence.m);assert.equal(JSON.stringify(evidence),original);
  for(const over of [{...evidence,m:evidence.m+'A'.repeat(maximum+1-reachable)},padded(path,reachable+2)]) {
    const untouched=JSON.stringify(over),empty=store();
    assert.throws(()=>createSignedClaim(over,'Player',2900,{storage:empty,consented:()=>true}),/ranked_move_limit/);
    assert.equal(empty.data.size,0);assert.equal(JSON.stringify(over),untouched);
  }
});
test('practice, assistance, malformed evidence/name and withdrawn consent never create identity',()=>{
  const rejected=[...paths.filter(path=>path.practice),{...playerClaim,assisted:true},{...playerClaim,m:'A'},{...playerClaim,l:'unknown'}];
  for(const evidence of rejected) {
    const storage=store();assert.throws(()=>createSignedClaim(evidence,'Player',2900,{storage,consented:()=>true}));assert.equal(storage.data.size,0);
  }
  const storage=store();
  assert.throws(()=>createSignedClaim(playerClaim,'bad"name',2900,{storage,consented:()=>true}),/malformed/);
  let checks=0;
  assert.throws(()=>createSignedClaim(playerClaim,'Player',2900,{storage,consented:()=>++checks===1}),/consent_required/);
  assert.equal(storage.data.size,0);
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
