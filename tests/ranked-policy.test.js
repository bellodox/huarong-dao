import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as profile from '../leaderboard/profile.js';
import { canonical,signPlayer,signApp,recover,receiptId,utf8,digest } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { verifyOffline } from '../leaderboard/relay-entry.js';
import { reconstruct } from '../leaderboard/reconcile.js';
import { rank } from '../leaderboard/index.js';
import { admit } from '../leaderboard/issuer.js';
import { buildTransaction,signTransaction,serialize,payScript,hash256 } from '../leaderboard/chain.js';
import { bytesToHex } from '../leaderboard/receipt.js';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
const paths=JSON.parse(readFileSync(new URL('./fixtures/paths.json',import.meta.url)));
const legacy=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const playerSecret=Uint8Array.from([...Array(31).fill(0),1]);
const appSecret=Uint8Array.from([...Array(31).fill(0),2]);
const appKey=secp256k1.getPublicKey(appSecret),markerKey=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),3]));
const playerKey=bytesToHex(secp256k1.getPublicKey(playerSecret));
const ceilings={wings:1160,heng_dao_li_ma:1180,rear_guard:820,small_obstacle:1000,ambush:1100,fayaa_sideBySide:850,fayaa_threeRoads:920,fayaa_peach:1000,fayaa_rain2:1190,fayaa_cannotStop:1260,fayaa_highRisk:1260};
/** Pad only with legal reversible moves, retaining the complete solved path. */
function evidence(path,moves,p='hd2') {
  const state=profile.positions(path.b);
  let pair;
  for(let action=0;action<40;action++)try {
    const reverse=profile.ALPHABET[(action&~3)+((action%4+2)%4)];
    if(profile.occupancy(profile.step(profile.step(state,profile.ALPHABET[action]),reverse))===path.b){pair=profile.ALPHABET[action]+reverse;break;}
  }catch{}
  assert(pair);assert.equal((moves-path.m.length)%2,0);
  return {p,w:9999999999,l:path.l,b:path.b,n:'😀'.repeat(12),m:pair.repeat((moves-path.m.length)/2)+path.m};
}
for(const [layout,maximum] of Object.entries(ceilings))test(`hd2 ${layout}: inclusive maximum ${maximum}, maximum+1 rejected, complete signed capacity`,()=>{
  assert.equal(profile.RANKED_PROFILE,'hd2');assert.equal(profile.RANKED_MOVE_MULTIPLIER,10);
  assert.equal(profile.RANKED_MAX_MOVES[layout],maximum);
  assert.equal(profile.rankedMoveLimit('hd2',layout),maximum);
  assert.equal(profile.rankedMoveLimit('hd1',layout),Infinity);
  assert.doesNotThrow(()=>profile.assertRankedMoves('hd2',layout,maximum));
  assert.throws(()=>profile.assertRankedMoves('hd2',layout,maximum+1),/ranked_move_limit/);
  const path=paths.find(path=>path.l===layout);
  // Single-cell board parity makes an even ceiling unreachable for odd-optimum layouts.
  const reachableMaximum=maximum-(maximum-path.optimum)%2;
  const unsigned=evidence(path,reachableMaximum),signed=signPlayer(unsigned,playerSecret),final=signApp(signed,appSecret);
  assert.equal(profile.replay(final).moves,reachableMaximum);
  assert.equal(verifyClaim(canonical(signed,7),receiptId(signed)).moves,reachableMaximum);
  assert.equal(verifyOffline(canonical(final,8),bytesToHex(appKey)).profile,'hd2');
  assert.equal(utf8(canonical(final,8)).length,310+layout.length+reachableMaximum);
  assert(utf8(canonical(final,8)).length<=1586);
  // The complete signed wire upper bound includes even ceilings that parity cannot solve.
  const wireMaximum=signApp(signPlayer({...unsigned,m:unsigned.m+'A'.repeat(maximum-reachableMaximum)},playerSecret),appSecret);
  assert.equal(utf8(canonical(wireMaximum,8)).length,310+layout.length+maximum);
  assert(utf8(canonical(wireMaximum,8)).length<=1586);
  if(layout==='fayaa_cannotStop')assert.equal(utf8(canonical(final,8)).length,1586);
  const exactOver=signPlayer({...unsigned,m:unsigned.m+'A'.repeat(maximum+1-reachableMaximum)},playerSecret);
  assert.throws(()=>verifyClaim(canonical(exactOver,7),receiptId(exactOver)),error=>error.code==='ranked_move_limit');
  const over=evidence(path,reachableMaximum+2),overSigned=signPlayer(over,playerSecret),original=over.m;
  assert.throws(()=>profile.replay(over),/ranked_move_limit/);
  assert.throws(()=>verifyClaim(canonical(overSigned,7),receiptId(overSigned)),error=>error.code==='ranked_move_limit'&&error.status===422);
  assert.equal(over.m,original);
  assert.equal(profile.replay({...over,p:'hd1'}).moves,reachableMaximum+2);
});
test('hd2 excludes all practice layouts and rejects unknown policy versions',()=>{
  for(const path of paths.filter(path=>path.practice)) {
    const claim={p:'hd2',w:2900,l:path.l,b:path.b,n:'Player',m:path.m};
    assert.throws(()=>profile.replay(claim),/practice_layout/);
    assert.throws(()=>profile.replay(claim,{allowPractice:true}),/practice_layout/);
    const signed=signPlayer(claim,playerSecret);
    assert.throws(()=>verifyClaim(canonical(signed,7),receiptId(signed)),error=>error.code==='practice_layout');
  }
  assert.throws(()=>profile.rankedMoveLimit('hd3','wings'),/unknown_profile/);
  assert.throws(()=>canonical({...legacy.playerClaim,p:'hd3'},7));
  assert.throws(()=>verifyClaim(JSON.stringify({...legacy.playerClaim,p:'hd3'}),'unused'),error=>error.code==='unknown_profile'&&error.status===422);
  assert.throws(()=>digest('player',JSON.stringify({p:'hd3'})),/unknown_profile/);
});
test('hd1 signatures remain byte-identical; hd2 domains bind version and player/app role',()=>{
  const {s,...oldUnsigned}=legacy.playerClaim;
  assert.deepEqual(signPlayer(oldUnsigned,playerSecret),legacy.playerClaim);
  assert.deepEqual(signApp(legacy.playerClaim,appSecret),legacy.receipt);
  assert.equal(profile.replay(legacy.maximumReceipt).moves,1722);
  const unsigned={...oldUnsigned,p:'hd2'},signed=signPlayer(unsigned,playerSecret),final=signApp(signed,appSecret);
  assert.notEqual(signed.s,s);assert.notEqual(receiptId(signed),receiptId(legacy.playerClaim));
  for(const [version,claim] of [['hd1',oldUnsigned],['hd2',unsigned]])for(const domain of ['player','app']) {
    const text=canonical(claim,6);
    assert.deepEqual(digest(domain,text),sha256(utf8(`huarong/${version}/${domain}\0${text}`)));
  }
  assert.equal(recover('player',canonical(unsigned,6),signed.s),playerKey);
  assert.notEqual(recover('player',canonical(oldUnsigned,6),signed.s),playerKey);
  assert.notEqual(recover('app',canonical(unsigned,6),signed.s),playerKey);
  assert.notEqual(recover('app',canonical({...signed,p:'hd1'},7),final.a),bytesToHex(appKey));
  const substituted={...legacy.receipt,p:'hd2'};
  assert.throws(()=>verifyOffline(canonical(substituted,8),bytesToHex(appKey)),/unauthorized_app/);
});
/** Build real signed name lineage so reconstruction exercises its independent contract. */
function history(receipts) {
  const funding={inputs:[{txid:'f'.repeat(64),index:0}],outputs:[{amount:10000000,script:payScript(appKey)}]};
  const fundingRaw=bytesToHex(serialize(funding));
  let previous={raw:fundingRaw,txid:bytesToHex(hash256(serialize(funding)).reverse())},amount=10000000,script=payScript(appKey);
  const headers=Array.from({length:20},(_,height)=>({height,hash:(height+1).toString(16).padStart(64,'0'),previous:height?height.toString(16).padStart(64,'0'):null,time:345600+604800*2900+height*30}));
  const transactions=receipts.map((receipt,index)=>{
    const tx=buildTransaction({operation:index?'update':'register',fee:40000,markerAmount:10000,nameAmount:amount-60000,inputs:[{txid:previous.txid,index:0,amount,script:bytesToHex(script),previousRaw:previous.raw}]},receipt,appKey,markerKey);
    previous=signTransaction(tx,appSecret);amount-=60000;script=tx.outputs[0].script;
    return {raw:previous.raw,height:index+1,index:0,blockHash:headers[index+1].hash};
  });
  return {complete:true,headers,previousTransactions:[fundingRaw],transactions,bootstrap:{txid:bytesToHex(hash256(Uint8Array.from(Buffer.from(transactions[0].raw,'hex'))).reverse()),appKey:bytesToHex(appKey),markerKey:bytesToHex(markerKey)}};
}
test('mixed hd1/hd2 raw reconstruction keeps shared identity, bests and earliest-chain tie provenance',()=>{
  const {a,s,...unsigned}=legacy.receipt;
  const hd2=signApp(signPlayer({...unsigned,p:'hd2'},playerSecret),appSecret);
  const result=reconstruct(history([legacy.receipt,hd2]));
  assert.equal(result.invalid.length,0);assert.equal(result.receipts.length,2);
  for(const options of [{},{scope:'week',week:2900}]) {
    const rows=rank(result.receipts,options);assert.equal(rows.length,1);assert.equal(rows[0].completed,1);
    assert.equal(rows[0].bests.wings.receipt_id,receiptId(legacy.playerClaim));
  }
  const over=evidence(paths.find(path=>path.l==='wings'),1162);
  const rejected=reconstruct(history([signApp(signPlayer(over,playerSecret),appSecret)]));
  assert.equal(rejected.receipts.length,0);assert.equal(rejected.invalid[0].code,'ranked_move_limit');
  assert.equal(reconstruct(history([signApp(signPlayer({...over,p:'hd1'},playerSecret),appSecret)])).receipts.length,1);
  for(const [layout,maximum] of Object.entries(ceilings)) {
    const path=paths.find(path=>path.l===layout),reachableMaximum=maximum-(maximum-path.optimum)%2;
    const maximumReceipt=signApp(signPlayer(evidence(path,reachableMaximum),playerSecret),appSecret);
    const overReceipt=signApp(signPlayer(evidence(path,reachableMaximum+2),playerSecret),appSecret);
    const boundary=reconstruct(history([maximumReceipt,overReceipt]));
    assert.equal(boundary.receipts.length,1);assert.equal(boundary.receipts[0].moves,reachableMaximum);
    assert.equal(boundary.invalid[0].code,'ranked_move_limit');
  }
});
test('SQL admission shares improvement and reservations across profile switches without migration',async()=>{
  const db=new PGlite();
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(migrations());
    await db.exec('update public.hd1_coordinator set paused=false,epoch=2900;');
    const storage={rpc:async(operation,payload)=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as result',[operation,JSON.stringify(payload)])).rows[0].result};
    const {s,...unsigned}=legacy.playerClaim;
    const claim=signPlayer({...unsigned,p:'hd2'},playerSecret);
    const old=verifyClaim(canonical(legacy.playerClaim,7),receiptId(legacy.playerClaim));
    const next=verifyClaim(canonical(claim,7),receiptId(claim));
    assert.equal((await admit(storage,old)).state,'queued');
    assert.equal((await admit(storage,next)).state,'not_improved');
    assert.equal((await storage.rpc('read',{})).claims.filter(row=>row.state==='queued').length,1);
  }finally{await db.close();}
});
