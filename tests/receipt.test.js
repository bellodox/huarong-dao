import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { canonical, parseCanonical, signPlayer, signApp, recover, receiptId, assertCapacity, bytesToHex, validName, base58check, decodeWif } from '../leaderboard/receipt.js';
import { CATALOG, replay, positions, occupancy, improves, epoch, medianTime, step, ALPHABET } from '../leaderboard/profile.js';
const paths=JSON.parse(readFileSync(new URL('./fixtures/paths.json',import.meta.url)));
export const playerSecret=Uint8Array.from([...Array(31).fill(0),1]);
export const appSecret=Uint8Array.from([...Array(31).fill(0),2]);
export const unsigned={p:'hd1',w:2900,l:'wings',b:CATALOG.wings.board,n:'Player',m:paths.find(p=>p.l==='wings').m};
export const playerClaim=signPlayer(unsigned,playerSecret);
export const receipt=signApp(playerClaim,appSecret);
test('all frozen catalog paths replay with exact optima and rectangular boards',()=>{
  for(const fixture of paths) {
    assert.equal(occupancy(positions(fixture.b)),fixture.b);
    assert.equal(replay(fixture,{allowPractice:true}).moves,fixture.optimum);
    assert.equal(replay(fixture,{allowPractice:true}).points,10*fixture.optimum);
    if(fixture.practice)assert.throws(()=>replay(fixture),/practice_layout/);
  }
});
test('strict improvement is lifetime OR weekly; inclusion epoch uses lower median',()=>{
  assert(improves(124,130,125));assert(improves(124,120,Infinity));assert(!improves(124,120,124));
  assert.equal(epoch(345600),0);assert.equal(epoch(345599),-1);
  assert.equal(medianTime([10,9,8,7]),8);
});
test('both canonical signature domains bind all evidence, normalize compressed identities',()=>{
  assert.equal(recover('player',canonical(unsigned,6),playerClaim.s),bytesToHex(secp256k1.getPublicKey(playerSecret)));
  assert.equal(recover('app',canonical(playerClaim,7),receipt.a),bytesToHex(secp256k1.getPublicKey(appSecret)));
  for(const [field,value] of [['w',2901],['l','rear_guard'],['n','Other'],['b',CATALOG.rear_guard.board],['m',unsigned.m+'A']]) {
    assert.notEqual(recover('player',canonical({...unsigned,[field]:value},6),playerClaim.s),bytesToHex(secp256k1.getPublicKey(playerSecret)));
  }
  assert.notEqual(recover('app',canonical(unsigned,6),playerClaim.s),bytesToHex(secp256k1.getPublicKey(playerSecret)));
  assert.match(receiptId(playerClaim),/^[a-f0-9]{64}$/);
});
test('canonical bytes reject alternate JSON, fields, escapes and invalid scalars',()=>{
  const text=canonical(playerClaim,7);
  for(const alternative of [text+'\n',text.replace('"hd1"','"hd1", "p":"hd1"'),text.replace('Player','\\u0050layer')])assert.throws(()=>parseCanonical(alternative,7));
  for(const name of ['','"','\\','<','\x7f','\x80','\ud800','e\u0301'])assert(!validName(name));
  assert(validName('😀'.repeat(12)));
});
test('invalid/post-solution moves and arbitrary boards fail',()=>{
  assert.throws(()=>replay({...unsigned,m:unsigned.m+'A'}));
  assert.throws(()=>replay({...unsigned,m:'_'}));assert.throws(()=>replay({...unsigned,m:''}));
  assert.throws(()=>replay({...unsigned,b:'.'.repeat(20)}));
});
test('1536 actual moves sign and replay; exact 2048 byte boundary never truncates',()=>{
  let state=positions(unsigned.b), pair;
  for(let action=0;action<40;action++)try {
    const next=step(state,ALPHABET[action]);const reverse=ALPHABET[(action&~3)+((action%4+2)%4)];
    if(occupancy(step(next,reverse))===unsigned.b){pair=ALPHABET[action]+reverse;break;}
  }catch{}
  assert(pair);
  const long={...unsigned,w:9999999999,n:'😀'.repeat(12),m:pair.repeat((1536-unsigned.m.length)/2)+unsigned.m};
  const signed=signApp(signPlayer(long,playerSecret),appSecret);
  assert.equal(replay(signed).moves,1536);assert.equal(new TextEncoder().encode(canonical(signed,8)).length,1851);
  const capacity={...playerClaim,w:9999999999,l:'abcdefghijklmnop',n:'😀'.repeat(12),m:'A'.repeat(1722)};
  assert.equal(assertCapacity(capacity),2048);assert.throws(()=>assertCapacity({...capacity,m:capacity.m+'A'}),/evidence_too_large/);
  const longest=paths.find(path=>path.l==='fayaa_threeRoads');
  let reversible;
  for(let action=0;action<40;action++)try {
    const initial=positions(longest.b),next=step(initial,ALPHABET[action]);
    const reverse=ALPHABET[(action&~3)+((action%4+2)%4)];
    if(occupancy(step(next,reverse))===longest.b){reversible=ALPHABET[action]+reverse;break;}
  }catch{}
  const maximum=signApp(signPlayer({p:'hd1',w:9999999999,l:longest.l,b:longest.b,n:'😀'.repeat(12),m:reversible.repeat((1722-longest.m.length)/2)+longest.m},playerSecret),appSecret);
  assert.equal(replay(maximum).moves,1722);assert.equal(new TextEncoder().encode(canonical(maximum,8)).length,2048);
  writeFileSync(new URL('./fixtures/receipt.json',import.meta.url),JSON.stringify({playerClaim,receipt,longReceipt:signed,maximumReceipt:maximum,playerKey:bytesToHex(secp256k1.getPublicKey(playerSecret)),appKey:bytesToHex(secp256k1.getPublicKey(appSecret))},null,2));
});
test('legacy WIF compression flag retained, normalized identity unchanged',()=>{
  for(const compressed of [false,true]) {
    const wif=base58check(Uint8Array.from([128,...playerSecret,...(compressed?[1]:[])]));
    assert.deepEqual(decodeWif(wif,128),playerSecret);assert.throws(()=>decodeWif(wif,129));
  }
});
