import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRelayRequest} from '../leaderboard/relay-entry.js';
import {handleRelayRequest as generatedHandler} from '../relay.js';
import {bindings} from './publisher-fixture.js';

const privateText='PRIVATE binding URL headers DSN backend message details hint';
/** Capture only this handler's diagnostics and prohibit operational RPCs or chain access. */
async function probe(env,transport,scope='lifetime',handler=handleRelayRequest) {
  const originalFetch=globalThis.fetch,originalError=console.error,logs=[],calls=[];
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).pathname,'/rest/v1/rpc/hd1_public');
    const {operation}=JSON.parse(init.body);assert(['readiness','leaderboard'].includes(operation));calls.push(operation);
    return transport(operation);
  };
  console.error=(...args)=>logs.push(args);
  try {
    const response=await handler(new Request('https://game.test/api/leaderboard?scope='+scope),env);
    return {status:response.status,body:await response.json(),logs,calls};
  }finally{globalThis.fetch=originalFetch;console.error=originalError;}
}
/** One bounded record and an additive safe response identify the failing boundary. */
function failure(result,diagnostic) {
  assert.equal(result.status,503);assert.equal(result.body.code,'backend_unavailable');assert.equal(result.body.retryable,true);
  assert.deepEqual(result.body.diagnostic,diagnostic);
  assert.deepEqual(result.logs,[[JSON.stringify({event:'hd1_backend_failure',...diagnostic})]]);
  assert(!JSON.stringify(result).includes(privateText));assert(JSON.stringify(result.logs).length<400);
}

test('readiness and public-read failures preserve only allowlisted upstream evidence',async()=>{
  for(const [status,code,category] of [[401,'PGRST301','authentication'],[403,'42501','permission'],[400,'22P02','database_input'],
    [503,'PGRST002','upstream_unavailable'],[500,'XX000','database_internal'],[400,privateText,'upstream_rejected']]) {
    const response=()=>Response.json({code,message:privateText,details:privateText,hint:privateText},{status});
    const expected={category,upstream_status:status,...(code!==privateText?{backend_code:code}:{})};
    failure(await probe(bindings,response,'invalid'),{stage:'readiness',...expected});
    failure(await probe({...bindings,HD1_PUBLISHER:'false',HD1_READS:'true'},response),{stage:'public_read',...expected});
  }
});

test('transport, timeout, malformed and oversized responses are distinguished without exception text',async()=>{
  for(const [transport,category] of [
    [()=>{throw Error(privateText);},'transport'],
    [()=>{throw new DOMException(privateText,'TimeoutError');},'timeout'],
    [()=>new Response(privateText,{status:502}),'invalid_response'],
    [()=>new Response(' '.repeat(262145)),'response_too_large']]) {
    const result=await probe(bindings,transport);
    failure(result,{stage:'readiness',category,...(category==='invalid_response'?{upstream_status:502}:category==='response_too_large'?{upstream_status:200}:{})});
  }
});

test('configuration and storage construction failures are contained before network access',async()=>{
  const env={get ROD_APP_WIF(){throw Error(privateText);}};
  failure(await probe(env,()=>assert.fail('network forbidden')),{stage:'configuration',category:'unexpected'});
  for(const value of [{url:privateText},'not a URL'])failure(await probe({...bindings,SUPABASE_URL:value},()=>assert.fail('network forbidden')),
    {stage:'storage_construction',category:'configuration'});
  failure(await probe({...bindings,SUPABASE_SERVICE_KEY:{privateText}},()=>assert.fail('network forbidden')),
    {stage:'storage_construction',category:'configuration'});
});

test('generated relay preserves diagnostic parity and ignores forged exception evidence',async()=>{
  for(const handler of [handleRelayRequest,generatedHandler]) {
    failure(await probe(bindings,()=>Response.json({code:'42501',message:privateText},{status:403}),'lifetime',handler),
      {stage:'readiness',category:'permission',upstream_status:403,backend_code:'42501'});
    for(const thrown of [null,privateText,{diagnostic:{category:privateText},message:privateText,status:403,code:'42501'}]) {
      const env={get ROD_APP_WIF(){throw thrown;}};
      failure(await probe(env,()=>assert.fail('network forbidden'),'lifetime',handler),{stage:'configuration',category:'unexpected'});
    }
  }
});

test('missing-schema readiness sentinels retain upgrade behavior without converting outages',async()=>{
  for(const message of ['invalid_query','unsupported_operation','schema_upgrade_required']) {
    const result=await probe(bindings,operation=>{
      if(operation==='readiness')throw Error(message);
      return Response.json({rows:[],pending:[],snapshot_revision:1,stale:true,has_more:false});
    });
    assert.equal(result.status,200);assert.equal(result.body.publisher.code,'schema_upgrade_required');assert.deepEqual(result.logs,[]);
  }
});

test('paused readiness remains a successful read and query errors produce no failure log',async()=>{
  const transport=operation=>Response.json(operation==='readiness'?{available:false,code:'publisher_unavailable',capability_revision:4,recovery_capability_revision:7}:
    {rows:[],pending:[],snapshot_revision:1,stale:true,has_more:false});
  const result=await probe(bindings,transport);
  assert.equal(result.status,200);assert.equal(result.body.available,false);assert.equal(result.body.publisher.code,'publisher_unavailable');
  assert.deepEqual(result.logs,[]);assert.deepEqual(result.calls,['readiness','leaderboard']);assert(!('diagnostic' in result.body));
  const invalid=await probe(bindings,transport,'invalid');assert.equal(invalid.status,400);assert.deepEqual(invalid.body,{code:'invalid_query'});assert.deepEqual(invalid.logs,[]);
});
