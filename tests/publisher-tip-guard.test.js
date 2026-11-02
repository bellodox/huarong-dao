import test from 'node:test';
import assert from 'node:assert/strict';
import { tipExtends } from '../leaderboard/tip-guard.js';
import { epoch, medianTime } from '../leaderboard/profile.js';

const PINNED = Object.freeze({height:100,hash:'a'.repeat(64)});
const NEXT = Object.freeze({height:101,hash:'b'.repeat(64)});
const BASE_TIME = 345600 + 604800 * 2900 + 10_000;
const headers = (from,to,ancestorHash=PINNED.hash,time=BASE_TIME) =>
  Array.from({length:to-from+1},(_,i)=>{
    const height=from+i;
    return {height,hash:height===100?ancestorHash:height===101?NEXT.hash:'c'.repeat(64),time};
  });
const api = (ancestorHash=PINNED.hash,time=BASE_TIME) => {
  const calls=[];
  return {calls,fetchHeaders:async(from,to)=>{calls.push([from,to]);return headers(from,to,ancestorHash,time);}};
};

test('unchanged tip needs no additional network call',async()=>{
  const a=api();
  assert.equal(await tipExtends(a,PINNED,PINNED),true);
  assert.deepEqual(a.calls,[]);
});
test('canonical extension retains validated old-tip hash',async()=>{
  const a=api();
  assert.equal(await tipExtends(a,PINNED,NEXT),true);
  assert.deepEqual(a.calls,[[100,101]]);
});
test('reorg replacing pinned block is rejected even if tip grew',async()=>{
  const a=api('d'.repeat(64));
  assert.equal(await tipExtends(a,PINNED,NEXT),false);
});
test('tip replacement at same height and tip rollback fail closed without additional reads',async()=>{
  const a=api();
  assert.equal(await tipExtends(a,PINNED,{height:100,hash:'e'.repeat(64)}),false);
  assert.equal(await tipExtends(a,PINNED,{height:99,hash:'f'.repeat(64)}),false);
  assert.deepEqual(a.calls,[]);
});
test('pre-sign accepts canonical extension in the same MTP epoch',async()=>{
  const a=api();
  const week=epoch(medianTime(Array(11).fill(BASE_TIME)));
  assert.equal(await tipExtends(a,PINNED,NEXT,week),true);
  assert.deepEqual(a.calls,[[91,101]]);
});
test('pre-sign rejects extension crossing into a different MTP epoch',async()=>{
  const nextWeekTime=BASE_TIME+604800;
  const a=api(PINNED.hash,nextWeekTime);
  assert.equal(await tipExtends(a,PINNED,NEXT,epoch(BASE_TIME)),false);
});
test('pre-sign rejects deep extension with replaced pinned block',async()=>{
  const a=api('d'.repeat(64));
  const later={height:120,hash:'c'.repeat(64)};
  assert.equal(await tipExtends(a,PINNED,later,epoch(BASE_TIME)),false);
  assert.deepEqual(a.calls,[]);
});
test('pre-sign rejects inconsistent observed-tip header',async()=>{
  const a=api();
  assert.equal(await tipExtends(a,PINNED,{height:101,hash:'f'.repeat(64)},epoch(BASE_TIME)),false);
});
test('failed canonical header fetch propagates instead of authorizing signing',async()=>{
  const a={fetchHeaders:async()=>{throw Error('header_gap');}};
  await assert.rejects(tipExtends(a,PINNED,NEXT,epoch(BASE_TIME)),/header_gap/);
});
