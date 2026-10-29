import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { buildTransaction,signTransaction,serialize,payScript,hash256,parseTransaction } from '../leaderboard/chain.js';
import { bytesToHex,hexToBytes,signPlayer,signApp } from '../leaderboard/receipt.js';
import { reconstruct,discoverHistory } from '../leaderboard/reconcile.js';
import { rank,leaderboardPage } from '../leaderboard/index.js';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const secret=Uint8Array.from([...Array(31).fill(0),2]),key=secp256k1.getPublicKey(secret),marker=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),3]));
function fixture() {
  const funding={inputs:[{txid:'f'.repeat(64),index:0}],outputs:[{amount:10000000,script:payScript(key)}]};
  const fundingRaw=bytesToHex(serialize(funding)),fundingId=bytesToHex(hash256(hexToBytes(fundingRaw)).reverse());
  const options={operation:'register',fee:40000,markerAmount:10000,nameAmount:5000000,inputs:[{txid:fundingId,index:0,amount:10000000,script:bytesToHex(payScript(key)),previousRaw:fundingRaw}]};
  const {a,s,...longUnsigned}=vectors.longReceipt;
  const firstReceipt=signApp(signPlayer({...longUnsigned,n:vectors.receipt.n},Uint8Array.from([...Array(31).fill(0),1])),secret);
  const firstTx=buildTransaction(options,firstReceipt,key,marker),first=signTransaction(firstTx,secret);
  const secondTx=buildTransaction({...options,operation:'update',nameAmount:4940000,inputs:[{txid:first.txid,index:0,amount:5000000,script:bytesToHex(firstTx.outputs[0].script),previousRaw:first.raw}]},vectors.receipt,key,marker),second=signTransaction(secondTx,secret);
  const headers=Array.from({length:20},(_,height)=>({height,hash:(height+1).toString(16).padStart(64,'0'),previous:height?height.toString(16).padStart(64,'0'):null,time:345600+604800*2900+height*30}));
  return {complete:true,headers,previousTransactions:[fundingRaw],bootstrap:{txid:first.txid,appKey:bytesToHex(key),markerKey:bytesToHex(marker)},transactions:[
    {raw:first.raw,height:1,index:0,blockHash:headers[1].hash},{raw:second.raw,height:2,index:0,blockHash:headers[2].hash}
  ]};
}
test('complete raw lineage reconstructs overwritten values with both signatures and replay, no database',()=>{
  const history=fixture(),result=reconstruct(history);
  assert.equal(result.receipts.length,2);assert.equal(result.pending.length,0);
  assert.deepEqual(result.receipts.map(row=>row.moves),[1536,116]);
  assert.equal(rank(result.receipts)[0].points,1160);assert.equal(rank(result.receipts)[0].completed,1);
  assert.equal(result.head,parseTransaction(history.transactions[1].raw).txid+':0');
  assert.equal(rank(result.receipts,{scope:'week',week:2900})[0].bests.wings.moves,116);
  const state={coordinator:{revision:4,epoch:2900,snapshot:{...result,stale:false}},claims:[{id:'pending',state:'queued',moves:1,points:99999}]};
  const page=leaderboardPage(state,new URLSearchParams('scope=lifetime'));
  assert.equal(page.rows[0].points,1160);assert.equal(page.pending.length,1);assert.equal(page.rewards_enabled,false);
  writeFileSync(new URL('./fixtures/history.json',import.meta.url),JSON.stringify(history,null,2));
});
test('six confirmations, crossing week hints, reorg rollback and external spend fail closed',()=>{
  const history=fixture();
  const pending=reconstruct({...history,headers:history.headers.slice(0,7)});
  assert.equal(pending.receipts.length,1);assert.equal(pending.pending.length,1);
  const crossed=fixture();crossed.headers.forEach(header=>header.time+=604800);
  assert(reconstruct(crossed).receipts.every(row=>row.epoch===2901));
  const rollback=reconstruct({...history,transactions:history.transactions.slice(0,1)});
  assert.equal(rank(rollback.receipts)[0].bests.wings.moves,1536);
  assert.throws(()=>reconstruct({...history,complete:false}),/canonical_history_required/);
  const external={inputs:[{txid:history.bootstrap.txid,index:0}],outputs:[{amount:4000000,script:payScript(marker)}]};
  assert.throws(()=>reconstruct({...history,transactions:[history.transactions[0],{raw:bytesToHex(serialize(external)),height:2,index:0,blockHash:history.headers[2].hash}]}),/name_lineage_conflict/);
  const unauthorized=fixture();unauthorized.bootstrap.appKey=bytesToHex(marker);
  assert.throws(()=>reconstruct(unauthorized));
});
test('all pages are exhausted, deduplicated and completeness is enforced',async()=>{
  const ids=Array.from({length:23},(_,i)=>i.toString(16).padStart(64,'0')),offsets=[];
  assert.deepEqual(await discoverHistory(async offset=>{offsets.push(offset);return {txcount:23,tx:ids.slice(offset,offset+10),snapshot:'tip'};}),ids);
  assert.deepEqual(offsets,[0,10,20]);
  await assert.rejects(discoverHistory(async()=>({txcount:1,tx:[],snapshot:'tip'})),/history_incomplete/);
  await assert.rejects(discoverHistory(async()=>({txcount:0,tx:[]})),/history_incomplete/);
});
