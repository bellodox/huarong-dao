import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { canonical,receiptId } from '../leaderboard/receipt.js';
import { bindings,chainFixture,databaseFixture } from './publisher-fixture.js';
const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const request=()=>new Request('https://game.test/api/score',{method:'POST',headers:{origin:'https://game.test',
  'cf-connecting-ip':'192.0.2.1','content-type':'application/json','idempotency-key':receiptId(playerClaim)},body:canonical(playerClaim,7)});
test('production Worker: configured readiness, read-only GET, cron waitUntil, request queue/recovery, sanitized responses',async()=>{
  const {db,storage}=await databaseFixture(),chain=chainFixture(),original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).startsWith('https://db.test/')) {
      const {operation,payload}=JSON.parse(init.body);calls.push({operation,public:String(url).endsWith('hd1_public')});
      return Response.json(await (String(url).endsWith('hd1_public')?storage.publicRead(operation,payload):storage.rpc(operation,payload)));
    }
    return chain.fetch(url,init);
  };
  const env={...bindings,ASSETS:{fetch:async()=>new Response('unchanged local play')}};
  const tasks=[],ctx={waitUntil:promise=>tasks.push(promise)};
  const settle=async()=>{await Promise.all(tasks.splice(0));};
  try {
    assert.equal(await(await worker.fetch(new Request('https://game.test/'),env,ctx)).text(),'unchanged local play');
    let response=await worker.fetch(new Request('https://game.test/api/leaderboard'),env,ctx);
    assert.equal((await response.json()).available,false);assert(calls.every(call=>call.public));
    assert.equal((await worker.fetch(request(),env,ctx)).status,503);
    worker.scheduled({},env,ctx);assert.equal(tasks.length,1);await settle();
    calls.length=0;chain.calls.length=0;
    const before=await storage.rpc('operational');
    response=await worker.fetch(new Request('https://game.test/api/leaderboard'),env,ctx);
    const ready=await response.json();assert.equal(ready.available,true);
    assert.equal(ready.publisher.first_registration_policy,'bounded_chain_rejected_duplicate');
    assert(calls.every(call=>call.public));assert.equal(chain.calls.length,0);
    assert.deepEqual(await storage.rpc('operational'),before);
    response=await worker.fetch(request(),env,ctx);assert.equal(response.status,202);
    const text=await response.text();assert.equal(JSON.parse(text).status,'queued');await settle();
    assert.equal(chain.broadcasts.length,1);
    const row=(await storage.read()).claims[0];
    response=await worker.fetch(new Request('https://game.test/api/submissions/'+row.id),env,ctx);
    const status=await response.text();assert.equal(JSON.parse(status).txid,row.txid);
    for(const sensitive of [bindings.ROD_APP_WIF,bindings.SUPABASE_URL,bindings.SUPABASE_SERVICE_KEY,bindings.HD1_RATE_HMAC_KEY,row.raw,row.bytes])
      assert(!text.includes(sensitive)&&!status.includes(sensitive));
    // Missing/retired/invalid/explicitly disabled configuration remains walletless and unavailable.
    for(const extra of [{ROD_APP_WIF:undefined,ROD_EXPERIMENT_ISSUER_WIF:bindings.ROD_APP_WIF},{ROD_APP_WIF:'not-a-wif'},{HD1_PUBLISHER:'false'},{HD1_RATE_HMAC_KEY:'short'}]) {
      assert.equal((await worker.fetch(request(),{...env,...extra},ctx)).status,503);
      const disabled=await worker.fetch(new Request('https://game.test/api/leaderboard'),{...env,...extra},ctx);
      assert.equal((await disabled.json()).available,false);
    }
    assert.equal(chain.broadcasts.length,1);
  }finally {globalThis.fetch=original;await db.close();}
});
