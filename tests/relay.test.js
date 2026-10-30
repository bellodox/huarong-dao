import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,copyFileSync,mkdtempSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { relayBuild,checkRelay } from './build-relay.js';
import { relayProbe } from './relay-probe.js';
import * as relay from '../relay.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { canonical,receiptId,signPlayer,hexToBytes } from '../leaderboard/receipt.js';
import { reconstruct } from '../leaderboard/reconcile.js';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name+'.json',import.meta.url)));
const vectors=fixture('receipt'),transactions=fixture('transactions'),history=fixture('history');
const text=canonical(vectors.playerClaim,7),final=canonical(vectors.receipt,8);
// No network/listener attempts, even if application code catches a thrown guard error.
const guard=`import net from 'node:net';import http from 'node:http';import https from 'node:https';import dns from 'node:dns';import tls from 'node:tls';import dgram from 'node:dgram';
let attempts=0;const denied=()=>{attempts++;throw Error('unintended_network_or_listener');};
net.Socket.prototype.connect=denied;net.Server.prototype.listen=denied;http.request=denied;https.request=denied;tls.connect=denied;dns.lookup=denied;dns.promises.lookup=denied;dgram.createSocket=denied;globalThis.fetch=denied;globalThis.WebSocket=denied;
process.on('exit',()=>{if(attempts)process.exitCode=99;});`;
/** Copy only the distribution and explicit input files, outside project/package ancestry. */
function isolated(run) {
  const directory=mkdtempSync(join(tmpdir(),'hd1-relay-'));
  try {
    copyFileSync(new URL('../relay.js',import.meta.url),join(directory,'relay.js'));
    const invoke=(args,input)=>spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(guard),...args],{
      cwd:directory,input,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,
      env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,PATH:process.env.PATH}
    });
    run(directory,invoke);
  }finally{rmSync(directory,{recursive:true,force:true});}
}
/** Assert process completion and a single bounded JSON result, never infer success from silence. */
function result(child,exit=0) {
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,exit,child.stdout+child.stderr);
  // A typeless ancestor package can trigger Node's documented ESM syntax-detection warning.
  // Do not suppress warnings: permit only this exact warning, fail on every other diagnostic.
  const diagnostic=child.stderr.replace(/\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\] Warning: Module type of [^\n]+\nReparsing as ES module because module syntax was detected\. This incurs a performance overhead\.\nTo eliminate this warning, add "type": "module" to [^\n]+\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/,'');
  assert.equal(diagnostic,'');return JSON.parse(child.stdout);
}
test('distribution is reproducible, self-contained and stale bytes fail closed',async()=>{
  assert.deepEqual(await relayBuild(),await relayBuild());await checkRelay();
  const directory=mkdtempSync(join(tmpdir(),'hd1-stale-'));
  try {
    const artifact=join(directory,'relay.js');writeFileSync(artifact,readFileSync(new URL('../relay.js',import.meta.url))+'\n// stale\n');
    await assert.rejects(checkRelay(artifact),/stale_relay/);
  }finally{rmSync(directory,{recursive:true,force:true});}
  const worker=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
  assert(!worker.includes('leaderboard/'));assert(!worker.includes('verifyClaim'));assert(worker.includes("from './relay.js'"));
  assert.equal(JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url))).build.command,'npm run check:relay');
});
test('bundled signatures, receipt IDs and register/long-script update bytes match frozen vectors',()=>{
  const {s,...unsigned}=vectors.playerClaim;
  assert.deepEqual(relayProbe({kind:'signatures',unsigned}),{player:text,receipt:final,id:receiptId(vectors.playerClaim)});
  for(const [prepared,receipt,expected] of [[transactions.prepared,vectors.longReceipt,transactions.register],[transactions.updatePrepared,vectors.receipt,transactions.update]]) {
    const probe=relayProbe({kind:'transaction',prepared,receipt,appKey:transactions.appKey,markerKey:transactions.markerKey});
    assert.equal(probe.raw,expected.raw);assert.equal(probe.txid,expected.txid);assert.equal(probe.weight,expected.weight);
    assert(probe.preimages.every(preimage=>preimage.endsWith('01000000')));
    if(prepared.operation==='update')assert(probe.preimages[0].includes(prepared.inputs[0].script));
  }
  assert.deepEqual(relay.verifyClaim(text,receiptId(vectors.playerClaim)),verifyClaim(text,receiptId(vectors.playerClaim)));
});
test('direct CLI verifies claim/issuer receipt and stdin with only relay.js and input, no network or listener',()=>isolated((directory,invoke)=>{
  writeFileSync(join(directory,'input.json'),text);
  assert.deepEqual(readdirSync(directory).sort(),['input.json','relay.js']);
  assert.deepEqual(result(invoke(['relay.js','verify','input.json'])),relay.verifyOffline(text));
  assert.deepEqual(result(invoke(['relay.js','verify','-'],text)),relay.verifyOffline(text));
  writeFileSync(join(directory,'input.json'),final);
  assert.deepEqual(result(invoke(['relay.js','verify','input.json',transactions.appKey])),relay.verifyOffline(final,transactions.appKey));
  assert.equal(result(invoke(['relay.js','verify','input.json']),1).code,'issuer_key_required');
  assert.equal(result(invoke(['relay.js','verify','input.json',transactions.markerKey]),1).code,'unauthorized_app');
  const {s,...unsigned}=vectors.playerClaim;
  const hd2=relay.signApp(signPlayer({...unsigned,p:'hd2'},hexToBytes('1'.padStart(64,'0'))),hexToBytes('2'.padStart(64,'0')));
  const hd2Text=canonical(hd2,8);
  assert.equal(result(invoke(['relay.js','verify','-',transactions.appKey],hd2Text)).profile,'hd2');
  assert.equal(result(invoke(['relay.js','verify','-',transactions.appKey],final.replace('hd1','hd2')),1).code,'unauthorized_app');
  const help=result(invoke(['relay.js','help']));assert.equal(help.packaged_executable,false);assert.equal(help.issuance,false);
}));
test('CLI rejects noncanonical, bad signatures/replay/profile/practice, oversized and malformed UTF-8 inputs',()=>isolated((directory,invoke)=>{
  const {s,...unsigned}=vectors.playerClaim;
  const signed=changes=>canonical(signPlayer({...unsigned,...changes},hexToBytes('1'.padStart(64,'0'))),7);
  const practice=fixture('paths').find(path=>path.practice);
  const cases=[text+' ',text.replace('hd1','hd3'),canonical({...vectors.playerClaim,s:'A'.repeat(87)},7),
    signed({m:'A'}),signed({l:practice.l,b:practice.b,m:practice.m}),'x'.repeat(8193),'{',Buffer.from([0xff])];
  for(const input of cases) {
    const rejected=result(invoke(['relay.js','verify','-'],input),1);assert.equal(rejected.ok,false);
  }
  assert.equal(result(invoke(['relay.js','broadcast']),1).code,'usage');
  assert.equal(result(invoke(['relay.js','verify','missing-private-path']),1).code,'invalid_input');
}));
test('offline reconstruction shares raw lineage, rankings, pending/reorg and failure behavior without Supabase',()=>isolated((directory,invoke)=>{
  writeFileSync(join(directory,'bootstrap.json'),JSON.stringify(history.bootstrap));
  const variants=[history,{...history,headers:history.headers.slice(0,7)},
    {...history,transactions:history.transactions.slice(0,1)}];
  for(const input of variants) {
    const source=JSON.stringify(input);writeFileSync(join(directory,'input.json'),source);
    const actual=result(invoke(['relay.js','reconstruct','input.json','bootstrap.json']));
    assert.deepEqual(actual,relay.reconstructOffline(source,JSON.stringify(history.bootstrap)));
    assert.deepEqual(actual.receipts,reconstruct(input).receipts);
  }
  writeFileSync(join(directory,'input.json'),JSON.stringify({...history,complete:false}));
  assert.equal(result(invoke(['relay.js','reconstruct','input.json','bootstrap.json']),1).code,'canonical_history_required');
  assert.equal(result(invoke(['relay.js','status',receiptId(vectors.playerClaim)]),1).code,'issuance_disabled');
}));
test('Worker and Node library imports never start CLI, read stdin, listen or use network',()=>isolated((directory,invoke)=>{
  const moduleUrl=new URL('../worker.js',import.meta.url).href;
  result(invoke(['--input-type=module','--eval',`process.argv=['node','relay.js','verify','missing'];await import('./relay.js');await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify({ok:true}));`]));
}));
test('operational status reuses the explicit server-only read boundary without exposing configuration',async()=>{
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({status:'queued',receipt_id:receiptId(vectors.playerClaim)});};
  try {
    const response=await relay.handleRelayRequest(new Request('https://relay.invalid/api/submissions/'+receiptId(vectors.playerClaim)),
      {HD1_READS:'true',SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_KEY:'private-fixture-value'});
    assert.equal(response.status,200);assert.equal((await response.json()).status,'queued');
    assert.deepEqual(calls,[{url:'https://db.invalid/rest/v1/rpc/hd1_public',body:{operation:'status',payload:{id:receiptId(vectors.playerClaim)}}}]);
  }finally{globalThis.fetch=original;}
});
