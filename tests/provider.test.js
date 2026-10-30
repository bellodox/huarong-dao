import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { migrations } from './schema.js';
import { buildTransaction,signTransaction,serialize,payScript,address,parseTransaction,hash256 } from '../leaderboard/chain.js';
import { bytesToHex,hexToBytes,canonical,receiptId,signApp } from '../leaderboard/receipt.js';
import { verifyClaim } from '../leaderboard/verify.js';
import { admit,advance } from '../leaderboard/issuer.js';
import { createSpaceXpanseProvider,createTransport,headerHash,merkleRoot,PROVIDER_DEFAULTS,PROVIDER_TRUST } from '../leaderboard/provider.js';

const {playerClaim}=JSON.parse(readFileSync(new URL('./fixtures/receipt.json',import.meta.url)));
const secret=Uint8Array.from([...Array(31).fill(0),2]),appKey=secp256k1.getPublicKey(secret);
const markerKey=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),3]));
const strangerKey=secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0),9]));
const GENESIS=PROVIDER_DEFAULTS.genesisHash,BASE=100;
const txidOf=raw=>bytesToHex(hash256(hexToBytes(raw)).reverse());
const filler=n=>bytesToHex(hash256(Uint8Array.from([n>>8,n&255,7]))).toString();
/** Version-1 wallet-style payment (live funding shape), never app-generated. */
function payment(seed,key,amount) {
  return bytesToHex(serialize({version:1,inputs:[{txid:filler(seed),index:0}],outputs:[{amount,script:payScript(key)}],locktime:0}));
}

/** In-memory chain answering exactly like rod-api-server's REST routes (envelope {error,id,result}). */
function mockChain() {
  const chain={blocks:[],txs:new Map(),mempool:[],calls:[],hooks:{},chainName:'main',genesis:GENESIS};
  chain.mine=(raws=[],height=BASE+chain.blocks.length)=>{
    const prev=chain.blocks.at(-1)?.hash??'ab'.repeat(32),tx=[filler(height+1000),...raws.map(txidOf)];
    const block={height,previousblockhash:prev,merkleroot:merkleRoot(tx),version:536870912,time:345600+604800*2900+height*30,nonce:height,bits:'00000000',tx,txcount:tx.length};
    block.hash=headerHash(block);chain.blocks.push(block);
    raws.forEach(raw=>chain.txs.set(txidOf(raw),{raw,block}));chain.mempool=chain.mempool.filter(raw=>!raws.includes(raw));
    return block;
  };
  chain.tip=()=>chain.blocks.at(-1);
  const scriptOf=addr=>[appKey,markerKey,strangerKey].map(key=>[address(key),bytesToHex(payScript(key))]).find(([a])=>a===addr)?.[1];
  const touching=script=>{const out=[];
    for(const [txid,{raw,block}] of chain.txs){const tx=parseTransaction(raw,{funding:true});
      const ins=tx.inputs.some(input=>{const p=chain.txs.get(input.txid);return p&&bytesToHex(parseTransaction(p.raw,{funding:true}).outputs[input.index].script).endsWith(script);});
      if(ins||tx.outputs.some(o=>bytesToHex(o.script).endsWith(script)))out.push({txid,height:block.height,raw});}
    for(const raw of chain.mempool){const tx=parseTransaction(raw,{funding:true});if(tx.outputs.some(o=>bytesToHex(o.script).endsWith(script))||tx.inputs.some(input=>chain.txs.get(input.txid)))out.push({txid:txidOf(raw),height:0,raw});}
    return out;};
  const ok=result=>({error:null,id:'api-server',result});
  const fail=(code,message)=>({error:{code,message},id:'api-server',result:null});
  chain.route=(path,init={})=>{
    const url=new URL(path,'https://x'),parts=url.pathname.split('/').filter(Boolean);
    const offset=Number(url.searchParams.get('offset')??0);
    if(parts[0]==='info'){const t=chain.tip();return ok({chain:chain.chainName,blocks:t.height,bestblockhash:t.hash,headers:t.height,mediantime:t.time});}
    if(parts[0]==='hash')return ok(chain.genesis);
    if(parts[0]==='range'){const top=Number(parts[1]),rows=[];for(let h=top-(offset-1);h<=top;h++){const b=chain.blocks[h-BASE];if(b)rows.push({...b,confirmations:chain.tip().height-h+1});}return ok(rows.reverse());}
    if(parts[0]==='history'){const script=scriptOf(parts[1]);if(!script)return {error:{code:404,message:'Invalid address length'},id:'api-server'};
      const list=touching(script).sort((a,b)=>(a.height||1e9)-(b.height||1e9)).reverse().map(e=>e.txid);
      return {...ok({tx:list.slice(offset,offset+10),txcount:list.length}),jsonrpc:'2.0'};}
    if(parts[0]==='transaction'){const entry=chain.txs.get(parts[1]);
      if(!entry){const raw=chain.mempool.find(r=>txidOf(r)===parts[1]);if(raw)return ok({hex:raw,txid:parts[1],height:-1,version:1});
        return fail(-5,'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.');}
      return ok({hex:entry.raw,txid:parts[1],blockhash:entry.block.hash,height:entry.block.height,confirmations:chain.tip().height-entry.block.height+1});}
    if(parts[0]==='unspent'){const script=scriptOf(parts[1]),spent=new Set();
      for(const {raw} of chain.txs.values())for(const input of parseTransaction(raw,{funding:true}).inputs)spent.add(input.txid+':'+input.index);
      const rows=[];for(const [txid,{raw,block}] of chain.txs)parseTransaction(raw,{funding:true}).outputs.forEach((o,index)=>{
        if(bytesToHex(o.script).endsWith(script)&&!spent.has(txid+':'+index))rows.push({txid,index,script:null,value:o.amount,height:block.height});});
      return {...ok(rows),jsonrpc:'2.0'};}
    if(parts[0]==='broadcast'){const raw=new URLSearchParams(init.body).get('raw');
      if(chain.txs.has(txidOf(raw))||chain.mempool.includes(raw))return fail(-27,'transaction already in block chain');
      chain.mempool.push(raw);return ok(txidOf(raw));}
    return {error:{code:404,message:'Method not found'},id:'api-server'};
  };
  chain.fetch=async(url,init={})=>{
    const path=url.replace('https://api.test',''),count=chain.calls.push(path);
    const hook=chain.hooks.any?.(path,count);if(hook)return hook;
    const body=JSON.stringify(chain.route(path,init));
    return new Response(body,{status:200,headers:{'content-type':'application/json'}});
  };
  return chain;
}
function provider(chain,extra={}) {
  return createSpaceXpanseProvider({baseUrl:'https://api.test',fetch:chain.fetch,appKey:bytesToHex(appKey),markerKey:bytesToHex(markerKey),
    anchor:{height:BASE,hash:chain.blocks[0].hash},retryDelayMs:0,sleep:async()=>{},...extra});
}
/** Anchor + mature v1 funding, then (optionally) an app registration and update with spam markers. */
function fundedChain() {
  const chain=mockChain();chain.mine();
  const funding=payment(1,appKey,10000000),second=payment(2,appKey,5000000),foreign=payment(3,strangerKey,9000000);
  chain.mine([funding,foreign]);chain.mine([second]);for(let i=0;i<10;i++)chain.mine();
  return {chain,funding,second};
}
function signedOperation(prepared,receipt=signApp(playerClaim,secret)) {
  return signTransaction(buildTransaction(prepared,receipt,appKey,markerKey),secret);
}
async function registered() {
  const {chain,funding,second}=fundedChain();
  const first=await provider(chain,{allowUnprovenNameAbsence:true}).prepare({bytes:canonical(playerClaim,7)});
  const register=signedOperation(first.prepared);chain.mine([register.raw]);
  for(let i=0;i<6;i++)chain.mine();
  return {chain,register,funding,second};
}
async function issuerSetup() {
  const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(migrations());await db.exec('update public.hd1_coordinator set paused=false,epoch=2900;');
  const storage={rpc:async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value};
  storage.read=()=>storage.rpc('read');
  const verified=verifyClaim(canonical(playerClaim,7),receiptId(playerClaim));await admit(storage,verified);
  return {db,storage,id:verified.id};
}

test('transport: https only, result/error envelopes, GET-only bounded retries, timeout and size bounds',async()=>{
  assert.throws(()=>createTransport({baseUrl:'http://api.test'}),/invalid_provider_url/);
  let calls=0;
  const flaky=createTransport({baseUrl:'https://api.test',retryDelayMs:0,sleep:async()=>{},fetch:async()=>{calls++;
    if(calls<3)throw TypeError('network');return new Response('{"error":null,"id":"api-server","result":7}');}});
  assert.equal(await flaky.get('/x'),7);assert.equal(calls,3);
  calls=0;await assert.rejects(flaky.post('/broadcast',{raw:'00'}),/provider_unavailable/);assert.equal(calls,1);
  const slow=createTransport({baseUrl:'https://api.test',timeoutMs:5,retries:1,retryDelayMs:0,sleep:async()=>{},
    fetch:(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')))) });
  await assert.rejects(slow.get('/x'),/provider_timeout/);
  const reply=text=>createTransport({baseUrl:'https://api.test',retries:0,fetch:async()=>new Response(text)});
  await assert.rejects(reply('<html>').get('/x'),/provider_non_json/);
  await assert.rejects(reply('{"result":1}').get('/x'),/provider_envelope/);
  await assert.rejects(reply('{"error":{"code":-5,"message":"No such"},"result":null}').get('/x'),error=>error.message==='not_found');
  await assert.rejects(reply('{"error":{"code":1,"message":"history too large"}}').get('/x'),/history_too_large/);
  await assert.rejects(reply('{"error":{"code":404,"message":"ElectrumX request failed"}}').get('/x'),/provider_unavailable/);
  await assert.rejects(createTransport({baseUrl:'https://api.test',maxResponseBytes:10,fetch:async()=>new Response('{"error":null,"result":"0123456789"}')}).get('/x'),/provider_response_too_large/);
  await assert.rejects(createTransport({baseUrl:'https://api.test',retries:0,fetch:async()=>new Response('x',{status:404})}).get('/x'),/provider_http/);
});
test('transport cancels chunked oversize before full consumption and counts UTF-8 bytes',async()=>{
  let pulled=0,cancelled=false,calls=0;
  const transport=createTransport({baseUrl:'https://api.test',maxResponseBytes:32,fetch:async()=>{
    calls++;
    return new Response(new ReadableStream({
      pull(controller){pulled++;controller.enqueue(new Uint8Array(17));if(pulled===100)controller.close();},
      cancel(){cancelled=true;}
    },{highWaterMark:0}));
  }});
  await assert.rejects(transport.get('/chunked'),/provider_response_too_large/);
  assert.equal(pulled,2);assert.equal(cancelled,true);assert.equal(calls,1);
  const text=JSON.stringify({error:null,result:'€€€€'}),bytes=new TextEncoder().encode(text);
  assert(bytes.length>text.length);
  await assert.rejects(createTransport({baseUrl:'https://api.test',maxResponseBytes:text.length,
    fetch:async()=>new Response(bytes)}).get('/utf8'),/provider_response_too_large/);
  const split=createTransport({baseUrl:'https://api.test',maxResponseBytes:bytes.length,fetch:async()=>
    new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}}))});
  assert.equal(await split.get('/exact'),'€€€€');
  let advertisedReads=0,advertisedCancelled=false;
  const advertised=createTransport({baseUrl:'https://api.test',maxResponseBytes:32,fetch:async()=>new Response(new ReadableStream({
    pull(controller){advertisedReads++;controller.enqueue(new Uint8Array(1));},cancel(){advertisedCancelled=true;}
  },{highWaterMark:0}),{headers:{'content-length':'1000000'}})});
  await assert.rejects(advertised.get('/advertised'),/provider_response_too_large/);
  assert.equal(advertisedReads,0);assert.equal(advertisedCancelled,true);
  const malformed=createTransport({baseUrl:'https://api.test',fetch:async()=>new Response(Uint8Array.of(0xff))});
  await assert.rejects(malformed.get('/bad-utf8'),/provider_non_json/);
  let timedOutCancelled=false;
  const stalled=createTransport({baseUrl:'https://api.test',timeoutMs:5,retries:0,fetch:async()=>new Response(new ReadableStream({
    cancel(){timedOutCancelled=true;}
  },{highWaterMark:0}))});
  await assert.rejects(stalled.get('/stalled-body'),/provider_timeout/);assert.equal(timedOutCancelled,true);
});
test('header and merkle recomputation match the live provider shape; tampering fails',()=>{
  // Public block 4267428 from api.spacexpanse.org:1234 (2026-10-30 probe), two transactions.
  assert.equal(merkleRoot(['aa4817b04ad9f24f633214746333d7cf4bda01792028f6546cc042b9aae6717e','304d8ed67c38094a44cc44f089df7ed9194420ae2bc8533c84f9a989e2cd7d65']),
    '2b3ba6e8e2484c463a95b8b646ab2b6c4ffd8aec054db1962607bd327c0846e9');
  assert.equal(headerHash({version:536870912,previousblockhash:'97c2b03d0819c055006046309d474a784fa155188608b8f2ef89ab81a113ee70',
    merkleroot:'33d49e007484f65e5f0b8bd4c0d701972a2d0d9c4abaf33b5ff1094db790ec34',time:1793320299,bits:'00000000',nonce:1320577}),
    'c0f8fdd2020966e2b2376513d2f7ce7aa803566327ab4ddc4b14540a8bad1e28');
  assert.throws(()=>merkleRoot(['aa'.repeat(32),'aa'.repeat(32)]),/invalid_merkle/);
});
test('funding parser accepts live v1/non-final previous raws; generated policy stays strict v2/final',()=>{
  const v1=payment(5,appKey,1000);
  assert.throws(()=>parseTransaction(v1),/unsupported_transaction/);
  assert.equal(parseTransaction(v1,{funding:true}).version,1);
  const nonFinal=v1.replace('ffffffff','feffffff'); // the first ffffffff is the input sequence
  assert.equal(parseTransaction(nonFinal,{funding:true}).inputs[0].sequence,0xfffffffe);
  assert.throws(()=>parseTransaction(nonFinal.replace(/^01/,'03'),{funding:true}),/unsupported_transaction/);
});
test('first registration is explicit: no history, unproven absence fails closed, then exact bytes broadcast via issuer',async()=>{
  const {chain,funding}=fundedChain();
  await assert.rejects(provider(chain).prepare({bytes:canonical(playerClaim,7)}),/name_absence_unverified/);
  await assert.rejects(provider(chain).history(),/bootstrap_pin_required/);
  const live=provider(chain,{allowUnprovenNameAbsence:true});
  const observation=await live.prepare({bytes:canonical(playerClaim,7)});
  assert.equal(observation.mode,'first_registration');assert.equal(observation.head,null);assert.equal(observation.epoch,2900);
  assert.equal(observation.prepared.operation,'register');assert.equal(observation.prepared.inputs[0].previousRaw,funding);
  assert.equal(observation.prepared.markerAmount,600);assert.equal(observation.prepared.nameAmount,1000000);
  assert(observation.prepared.fee<=100000);assert.equal(observation.evidence.trust,PROVIDER_TRUST);
  assert.equal(await live.validate(observation),true);
  const {db,storage,id}=await issuerSetup();
  try {
    const result=await advance(storage,live,secret,markerKey,id);
    assert.equal(result.state,'broadcast_pending');
    const row=(await storage.read()).claims[0];
    assert.deepEqual(chain.mempool,[row.raw]);assert.equal(txidOf(row.raw),row.txid);
    const tx=parseTransaction(row.raw);assert.equal(tx.version,2);
    assert.equal(bytesToHex(tx.outputs[1].script),bytesToHex(payScript(markerKey)));
    // Identical-byte rebroadcast is acknowledged as the same txid, never a new spend.
    assert.equal(await live.broadcast(row.raw),row.txid);
    assert.deepEqual(await live.lookup(row.txid),{state:'mempool',txid:row.txid});
    // One unconfirmed: the pending registration blocks any further preparation.
    await assert.rejects(live.prepare({bytes:canonical(playerClaim,7)}),/bootstrap_pin_required/);
  }finally{await db.close();}
});
test('established lineage reconstructs from anchored history, prepares an update, and enforces one unconfirmed',async()=>{
  const {chain,register}=await registered();
  for(let i=0;i<12;i++)chain.mine([payment(100+i,markerKey,700)]); // forged marker spam over >1 page
  const live=provider(chain,{bootstrap:{txid:register.txid}});
  const history=await live.history();
  assert(history.transactions.length>10);assert.equal(history.evidence.txcount,13);
  assert.equal(history.anchor.height,BASE);
  const pageCalls=chain.calls.filter(path=>path.startsWith('/history/')).length;assert(pageCalls>=3);
  const observation=await live.prepare({bytes:canonical(playerClaim,7)});
  assert.equal(observation.mode,'established');assert.equal(observation.head,register.txid+':0');
  assert.equal(observation.prepared.operation,'update');assert.equal(observation.prepared.inputs[0].txid,register.txid);
  assert.equal(observation.prepared.nameAmount,1000000);
  assert.equal(await live.validate(observation),true);
  assert.equal(await live.validate({...observation,head:'0'.repeat(64)+':0'}),false);
  const update=signedOperation(observation.prepared);
  assert.equal(await live.broadcast(update.raw),update.txid);
  await assert.rejects(live.prepare({bytes:canonical(playerClaim,7)}),/unconfirmed_pending/);
  assert.equal(await live.validate(observation),false);
  chain.mine([update.raw]);for(let i=0;i<6;i++)chain.mine();
  const rebuilt=await live.history();
  assert.equal(rebuilt.transactions.filter(t=>t.raw===update.raw).length,1);
  const lookup=await live.lookup(update.txid);assert.equal(lookup.state,'included');assert.equal(lookup.confirmations,7);
  assert.equal((await live.prepare({bytes:canonical(playerClaim,7)})).head,update.txid+':0');
});
test('registration without a pinned bootstrap is never taken over',async()=>{
  const {chain}=await registered();
  await assert.rejects(provider(chain,{allowUnprovenNameAbsence:true}).prepare({bytes:canonical(playerClaim,7)}),/bootstrap_pin_required/);
});
test('stale tip, shifting pages, gaps and reorgs retry boundedly then fail closed precisely',async()=>{
  const {chain,register}=await registered();
  for(let i=0;i<12;i++)chain.mine([payment(200+i,markerKey,700)]);
  const live=()=>provider(chain,{bootstrap:{txid:register.txid}});
  // Tip moves during every acquisition.
  chain.hooks.any=(path)=>{if(path==='/info'&&chain.calls.filter(p=>p==='/info').length%2===0)chain.mine();};
  await assert.rejects(live().history(),error=>error.message==='history_unstable'&&error.detail.last==='tip_changed'&&error.detail.attempts===3);
  // Transient drift recovers within the bound.
  let once=true;chain.hooks.any=(path)=>{if(once&&path.includes('?offset=10')){once=false;chain.mine([payment(300,markerKey,700)]);}};
  assert.equal((await live().history()).evidence.txcount,14);
  // Count changes between pages every time.
  chain.hooks.any=(path)=>{if(path.includes('?offset=10'))chain.mempool.push(payment(400+chain.calls.length,markerKey,700));};
  await assert.rejects(live().history(),error=>error.message==='history_unstable'&&error.detail.last==='history_changed');
  chain.hooks.any=null;chain.mempool=[];
  // Short page (omitted entry) is a gap, never tolerated.
  chain.hooks.any=(path)=>{if(path.includes('?offset=10')){const body=chain.route(path);body.result.tx.pop();return new Response(JSON.stringify(body));}};
  await assert.rejects(live().history(),error=>error.detail.last==='history_page_gap');
  // Header range silently skipping a height is a gap.
  chain.hooks.any=(path)=>{if(path.startsWith('/range/')){const body=chain.route(path);body.result.splice(1,1);return new Response(JSON.stringify(body));}};
  await assert.rejects(live().history(),/header_gap/);
  // Transaction reported in a block hash that is not the canonical header at its height.
  chain.hooks.any=(path)=>{if(path==='/transaction/'+register.txid){const body=chain.route(path);body.result.blockhash='cd'.repeat(32);return new Response(JSON.stringify(body));}};
  await assert.rejects(live().history(),error=>error.detail.last==='reorg_detected');
  // Tampered header fields fail hash recomputation; broken linkage is a reorg signal.
  chain.hooks.any=(path)=>{if(path.startsWith('/range/')){const body=chain.route(path);body.result[2].time++;return new Response(JSON.stringify(body));}};
  await assert.rejects(live().history(),/invalid_header/);
  chain.hooks.any=null;
  // Anchor not on the provider's chain.
  await assert.rejects(provider(chain,{bootstrap:{txid:register.txid},anchor:{height:BASE,hash:'ef'.repeat(32)}}).history(),/anchor_mismatch/);
  // Incremental cache: a second sync only refetches the bounded recheck window.
  const cached=live();await cached.history();chain.calls.length=0;chain.mine();await cached.history();
  assert.equal(chain.calls.filter(p=>p.startsWith('/range/')).length,1);
  // Thirty-block recheck below the cached tip plus the one new block.
  assert.equal(chain.calls.find(p=>p.startsWith('/range/')),`/range/${chain.tip().height}?offset=31`);
});
test('wrong network, wrong raw, wrong scripts and UTXO mismatches fail closed',async()=>{
  const {chain,register,second}=await registered();
  const live=()=>provider(chain,{bootstrap:{txid:register.txid}});
  chain.chainName='test';await assert.rejects(live().status(),/wrong_network/);chain.chainName='main';
  chain.genesis='00'.repeat(32);await assert.rejects(live().status(),/wrong_network/);chain.genesis=GENESIS;
  chain.hooks.any=(path)=>{if(path==='/transaction/'+register.txid){const body=chain.route(path);body.result.hex=second;return new Response(JSON.stringify(body));}};
  await assert.rejects(live().history(),/provider_raw_mismatch/);
  chain.hooks.any=(path)=>{if(path.startsWith('/unspent/')){const body=chain.route(path);body.result.forEach(row=>row.value++);return new Response(JSON.stringify(body));}};
  await assert.rejects(live().prepare({bytes:canonical(playerClaim,7)}),/provider_utxo_mismatch/);
  chain.hooks.any=(path)=>{if(path.startsWith('/unspent/')){const body=chain.route(path);body.result=[{txid:'zz',index:0}];return new Response(JSON.stringify(body));}};
  await assert.rejects(live().prepare({bytes:canonical(playerClaim,7)}),/provider_shape/);
  // A UTXO row pointing at a foreign-script output is skipped, never signed.
  const foreign=[...chain.txs].find(([,{raw}])=>bytesToHex(parseTransaction(raw,{funding:true}).outputs[0].script)===bytesToHex(payScript(strangerKey)));
  chain.hooks.any=(path)=>{if(path.startsWith('/unspent/'))return new Response(JSON.stringify({error:null,result:[{txid:foreign[0],index:0,script:null,value:9000000,height:foreign[1].block.height}]}));};
  await assert.rejects(live().prepare({bytes:canonical(playerClaim,7)}),/funds_unavailable/);
  chain.hooks.any=(path)=>{if(path.startsWith('/unspent/'))return new Response(JSON.stringify({error:null,result:[]}));};
  await assert.rejects(live().prepare({bytes:canonical(playerClaim,7)}),/funds_unavailable/);
  chain.hooks.any=(path)=>{if(path==='/broadcast')return new Response(JSON.stringify({error:null,result:'00'.repeat(32)}));};
  await assert.rejects(live().broadcast(register.raw),/broadcast_txid_mismatch/);
  chain.hooks.any=null;
  // Unknown txid investigation is read-only and reports, never respends.
  const unknown=await live().lookup('ab'.repeat(32),[{txid:'cd'.repeat(32),index:0,script:bytesToHex(payScript(appKey))}]);
  assert.deepEqual(unknown,{state:'conflict_suspected',txid:'ab'.repeat(32),spent:['cd'.repeat(32)+':0']});
  assert.throws(()=>provider(chain,{markerKey:bytesToHex(appKey)}),/invalid_provider_config/);
  assert.throws(()=>provider(chain,{feePerByte:101}),/invalid_provider_config/);
});
