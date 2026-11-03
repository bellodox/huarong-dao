import test from 'node:test';
import assert from 'node:assert/strict';
import {handleScheduled} from '../leaderboard/relay-entry.js';
import {runPublisher} from '../leaderboard/publisher.js';

async function capture(action) {
  const logs=[];const old={log:console.log,warn:console.warn,error:console.error};
  for(const level of Object.keys(old))console[level]=(...args)=>logs.push({level,text:args.join(' ')});
  try {return {result:await action(),logs};}
  finally {Object.assign(console,old);}
}

test('cron configuration rejection emits a bounded, secret-free result',async()=>{
  const key='super_secret_must_not_be_logged';
  const {result,logs}=await capture(()=>handleScheduled({HD1_PUBLISHER:'false',ROD_APP_WIF:key}));
  assert.equal(result.code,'issuance_disabled');
  assert(logs.some(x=>x.text.includes('hd1_cron_result')&&x.text.includes('issuance_disabled')));
  assert(!JSON.stringify(logs).includes(key));
});

test('publisher preflight failures emit an explicit phase without exception text',async()=>{
  const key='secret_preflight_message';
  let rejected=false;
  const {logs}=await capture(async()=>{
    try {await runPublisher({publicRead:async()=>{throw Error(key);}},{});}
    catch {rejected=true;}
  });
  assert(rejected);
  assert(logs.some(x=>x.text.includes('hd1_publisher_early_failure')&&x.text.includes('readiness')));
  assert(!JSON.stringify(logs).includes(key));
});

test('SQL job rejection is visible even when Cloudflare invocation succeeds',async()=>{
  const storage={publicRead:async()=>({available:false,code:'publisher_stale',capability_revision:4}),
    rpc:async()=>({code:'finite_scope_required'})};
  const {result,logs}=await capture(()=>runPublisher(storage,{}));
  assert.equal(result.code,'finite_scope_required');
  assert(logs.some(x=>x.text.includes('job_rejected')&&x.text.includes('finite_scope_required')));
});
