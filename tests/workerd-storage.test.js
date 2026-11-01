import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {bindings} from './publisher-fixture.js';

/** Real Workers native fetch must reach only the public SQL adapter, never cron or a chain API. */
test('workerd configured enabled and disabled GETs preserve native fetch receiver and read-only routing',async()=>{
  for(const enabled of [true,false]) {
    const calls=[];
    const runtime=new Miniflare(convertV4MiniflareOptions({
      modules:[{type:'ESModule',path:'worker.js',contents:readFileSync(new URL('../worker.js',import.meta.url),'utf8')},
        {type:'ESModule',path:'relay.js',contents:readFileSync(new URL('../relay.js',import.meta.url),'utf8')}],
      compatibilityDate:'2026-10-23',log:new Log(LogLevel.NONE),
      bindings:{...bindings,...(!enabled?{HD1_PUBLISHER:'false',HD1_READS:'true'}:{})},
      outboundService:async request=>{
        const url=new URL(request.url),{operation}=await request.json();
        assert.equal(url.origin,bindings.SUPABASE_URL);assert.equal(url.pathname,'/rest/v1/rpc/hd1_public');assert.equal(request.method,'POST');
        assert(['readiness','leaderboard','status'].includes(operation));calls.push(operation);
        return Response.json(operation==='readiness'?{available:false,code:'publisher_unavailable',capability_revision:4,recovery_capability_revision:7}:
          operation==='status'?null:{rows:[],pending:[],snapshot_revision:1,stale:true,has_more:false});
      }
    }));
    try {
      const response=await runtime.dispatchFetch('https://game.test/api/leaderboard?scope=lifetime');
      assert.equal(response.status,200);const result=await response.json();
      assert.equal(result.available,false);assert.equal(result.publisher.code,enabled?'publisher_unavailable':'issuance_disabled');
      assert.deepEqual(calls,enabled?['readiness','leaderboard']:['leaderboard']);
      calls.length=0;
      const invalid=await runtime.dispatchFetch('https://game.test/api/leaderboard?scope=invalid');
      assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{code:'invalid_query'});
      assert.deepEqual(calls,enabled?['readiness']:[]);
      calls.length=0;
      const status=await runtime.dispatchFetch('https://game.test/api/submissions/'+'a'.repeat(64));
      assert.equal(status.status,404);assert.deepEqual(calls,enabled?['readiness','status']:['status']);
    }finally{await runtime.dispose();}
  }
});
