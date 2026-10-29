import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { SupabaseStorage } from '../leaderboard/storage.js';
import { handleApi } from '../worker.js';
import { leaderboardPage } from '../leaderboard/index.js';

test('public SQL reads are bounded whitelists, read-only, separately routed and snapshot paginated',async()=>{
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(migrations());
  const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
  const { reconstruct }=await import('../leaderboard/reconcile.js');const snapshot={...reconstruct(history),stale:false};
  const calls=[];
  const storage=new SupabaseStorage('https://fixture.test','public-fixture-service-role',async(url,options)=>{
    const body=JSON.parse(options.body),name=url.endsWith('/hd1_public')?'hd1_public':'hd1_rpc';calls.push([name,body.operation]);
    if(name==='hd1_rpc')throw Error('public GET used operational RPC');
    return Response.json((await db.query('select public.hd1_public($1,$2::jsonb) as value',[body.operation,JSON.stringify(body.payload)])).rows[0].value);
  });

  const get=path=>handleApi(new Request('https://game.test'+path),{storage,available:true,issuer:new Proxy({},{get(){throw Error('GET must not issue');}})});
  try {
    const rpc=async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
    await rpc('rebuild',{revision:(await db.query('select revision from public.hd1_coordinator')).rows[0].revision,epoch:2900,head:snapshot.head,snapshot});
    await db.exec("insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision,raw,txid) values(repeat('a',64),'PRIVATE-BYTES','02'||repeat('1',64),'Private','wings',2900,120,1,'broadcast_unknown',0,'00',repeat('b',64));");
    const first=await get('/api/leaderboard');assert.equal(first.status,200);
    const page=await first.json();assert.equal(page.rows[0].points,1160);assert.equal(page.pending.length,1);
    assert.match(first.headers.get('cache-control'),/max-age=5/);
    const expected=leaderboardPage(await rpc('read'),new URLSearchParams());assert.deepEqual(page.rows,expected.rows);
    const length=JSON.stringify(page).length;
    await db.exec("insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision) select lpad(to_hex(i),64,'0'),repeat('private rejected',100),'02'||repeat('2',64),'Rejected','wings',2900,150,1,'not_improved',0 from generate_series(1,500) i;");
    const after=await (await get('/api/leaderboard')).json();assert.equal(JSON.stringify(after).length,length);
    assert(!JSON.stringify(after).includes('PRIVATE'));assert(!JSON.stringify(after).includes('receipt"'));
    const status=await get('/api/submissions/'+'a'.repeat(64));assert.equal(status.status,200);
    const result=await status.json();assert.equal(result.status,'broadcast_unknown');assert.equal(result.receipt_id,'a'.repeat(64));assert(!('raw' in result));assert(!('prepared' in result));
    assert.equal((await get('/api/submissions/'+'f'.repeat(64))).status,404);
    assert.equal((await get('/api/leaderboard?limit=101')).status,400);
    assert.equal((await get('/api/leaderboard?cursor='+encodeURIComponent(btoa(JSON.stringify({fingerprint:'wrong',offset:1}))))).status,400);
    await db.exec("insert into public.hd1_receipts select lpad(to_hex(i+1000),64,'0'),lpad(to_hex(i+1000),64,'0'),'02'||lpad(to_hex(i),64,'0'),'Player '||i,'wings',2900,116+i,1000-i,1,i,0,'PRIVATE RECEIPT' from generate_series(1,125) i;");
    const state=await rpc('read');state.coordinator.snapshot.receipts=(await db.query('select * from public.hd1_receipts order by height,transaction_index,output_index')).rows;
    for(const params of ['limit=100','scope=week&week=2900&layout=wings&limit=20','scope=week&week=2901','player=02'+(1).toString(16).padStart(64,'0')]) {
      const response=await get('/api/leaderboard?'+params);assert.equal(response.status,200);
      const result=await response.json();assert.deepEqual(result.rows,leaderboardPage(state,new URLSearchParams(params)).rows);
    }
    const firstPage=await (await get('/api/leaderboard?limit=100')).json();assert.equal(firstPage.rows.length,100);assert(firstPage.cursor);
    const secondPage=await (await get('/api/leaderboard?limit=100&cursor='+encodeURIComponent(firstPage.cursor))).json();
    assert.equal(secondPage.rows.length,26);assert.equal(secondPage.cursor,null);
    assert.equal(new Set([...firstPage.rows,...secondPage.rows].map(row=>row.player)).size,126);
    await db.exec("update public.hd1_coordinator set revision=revision+1;");
    assert.equal((await get('/api/leaderboard?limit=100&cursor='+encodeURIComponent(firstPage.cursor))).status,400);
    await db.exec("insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision) select lpad(to_hex(i+2000),64,'0'),'PRIVATE','02'||lpad(to_hex(i),64,'0'),'Pending','wings',2900,150,1,'reorged',0 from generate_series(1,30) i;");
    assert.equal((await (await get('/api/leaderboard')).json()).pending.length,20);
    await db.exec('set role service_role;begin read only;');
    await db.query("select public.hd1_public('leaderboard','{}')");
    await db.query("select public.hd1_public('status',jsonb_build_object('id',repeat('a',64)))");
    await db.exec('rollback;reset role;');
    const definitions=(await db.query("select provolatile,prosrc from pg_proc where proname='hd1_public'")).rows;
    assert.equal(definitions[0].provolatile,'s');assert.doesNotMatch(definitions[0].prosrc,/for\s+update|hd1_rpc|\binsert\b|\bdelete\b|\bupdate\s+public/i);
    assert(calls.every(([name])=>name==='hd1_public'));
    await db.exec('set role anon;');await assert.rejects(db.query("select public.hd1_public('leaderboard','{}')"),/permission denied/);
  }finally{await db.close();}
});

test('public storage rejects oversized streamed responses without JSON parsing',async()=>{
  const storage=new SupabaseStorage('https://fixture.test','fixture',async()=>new Response(' '.repeat(262145)));
  await assert.rejects(storage.publicRead('leaderboard'),/public_response_too_large/);
});
