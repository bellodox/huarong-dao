import test from 'node:test';
import assert from 'node:assert/strict';
import {SupabaseStorage,storageDiagnostic} from '../leaderboard/storage.js';
const secret='PRIVATE DATABASE MESSAGE SQL DETAILS HINT SERVICE SECRET';
const storageFor=(reply)=>new SupabaseStorage('https://project.supabase.co','test-key',async()=>reply());
test('operational job RPC preserves allowlisted status/code without leaking backend messages',async()=>{
  for (const [status,code,expected] of [
    [403,'42501','permission'],[401,'PGRST301','authentication'],
    [404,'PGRST202','schema'],[500,'42883','schema'],
    [400,'22P02','database_input'],[502,'PGRST002','upstream_unavailable']
  ]) {
    const store=storageFor(()=>Response.json({code,message:secret,details:secret,hint:secret},{status}));
    await assert.rejects(store.rpc('job',{owner:'diagnostic'}),error=>{
      const d=storageDiagnostic(error);
      assert.deepEqual(d,{category:expected,upstream_status:status,backend_code:code});
      assert.equal(error.message,'storage_unavailable');
      assert(!JSON.stringify(d).includes(secret));return true;
    });
  }
});
test('unknown RPC error codes and large error bodies never leak details',async()=>{
  for(const body of [JSON.stringify({code:secret,message:secret}),secret,' '.repeat(100000)]) {
    const store=storageFor(()=>new Response(body,{status:500}));
    await assert.rejects(store.rpc('job'),error=>{
      assert.deepEqual(storageDiagnostic(error),{category:'upstream_unavailable',upstream_status:500});
      assert(!String(error).includes(secret));return true;
    });
  }
});
test('successful operational RPC behavior remains unchanged; malformed responses are categorized',async()=>{
  const good=storageFor(()=>Response.json({code:'job_busy'}));
  assert.deepEqual(await good.rpc('job'),{code:'job_busy'});
  const malformed=storageFor(()=>new Response('{bad', {status:200}));
  await assert.rejects(malformed.rpc('job'),error=>{
    assert.deepEqual(storageDiagnostic(error),{category:'invalid_response',upstream_status:200});return true;
  });
});
