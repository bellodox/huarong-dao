import { parseTransaction,parseName,payScript,address,hash256,concat,le,serialize,nameScript,buildTransaction,APP_NAME,NETWORK,FEE_POLICY } from './chain.js';
import { bytesToHex,hexToBytes,parseCanonical } from './receipt.js';
import { reconstruct } from './reconcile.js';
import { epoch,medianTime } from './profile.js';

/** Existing SpaceXpanse rod-api-server (branch "new") adapter. Shapes grounded in its
 * server/rest.py + methods and public GET probes of the default endpoint (2026-10-30). */
export const PROVIDER_DEFAULTS=Object.freeze({
  baseUrl:'https://api.spacexpanse.org:1234',chain:'main',
  genesisHash:'5d4b20be4fc87d2333aea5235d9de1c685696fc935f806a9ffd71c9f9abf3c57',
  timeoutMs:10000,retries:2,retryDelayMs:250,maxResponseBytes:4000000,
  pageSize:10,maxHistoryPages:500,rangeChunk:100,maxHeaderSpan:20000,reorgRecheckDepth:30,acquisitionAttempts:3,
  feePerByte:20,markerAmount:NETWORK.dust,nameAmount:NETWORK.nameMinimum,maxFundingInputs:9,maxFundingCandidates:12,coinbaseMaturity:100,
  allowUnprovenNameAbsence:false
});
/** Explicit trust statement attached to every acquisition; never a consensus/completeness proof. */
export const PROVIDER_TRUST='provider_anchored: one provider\'s stable responses, recomputed header hashes/merkle roots and hash-linked headers from a pinned anchor; not independent consensus or proof that nothing was omitted';
const HEX64=/^[a-f0-9]{64}$/, KEY=/^0[23][a-f0-9]{64}$/, ZERO=('0').repeat(64);
// Signed P2PKH unlocking script upper bound: push(DER<=72 + hashtype) + push(33-byte key).
const SIGNED_INPUT_BYTES=108;
const RETRYABLE_TRANSPORT=new Set(['provider_timeout','provider_unavailable']);
const RETRYABLE_ACQUISITION=new Set(['history_changed','history_page_gap','tip_changed','reorg_detected']);
const ALREADY_KNOWN=/already in block chain|txn-already-in-mempool|txn-already-known|already have transaction/i;

/** Error whose message is a stable code; detail is public, credential-free context. */
export function providerError(code,detail) {const error=Error(code);error.code=code;if(detail!==undefined)error.detail=detail;return error;}
/** Map rod-api-server error envelopes ({code,message}) to stable adapter codes. */
export function classifyEnvelope(error) {
  const message=String(error?.message??'').slice(0,200);
  if(error?.code===-5)return providerError('not_found',{providerCode:-5,message});
  if(/history too large/i.test(message))return providerError('history_too_large',{message});
  if(/ElectrumX/i.test(message))return providerError('provider_unavailable',{message});
  return providerError('provider_error',{providerCode:error?.code??null,message});
}
/** Bounded HTTPS JSON transport: timeout, size cap, envelope validation, GET-only retries. */
export function createTransport({baseUrl=PROVIDER_DEFAULTS.baseUrl,fetch:fetcher=globalThis.fetch,timeoutMs=PROVIDER_DEFAULTS.timeoutMs,
  retries=PROVIDER_DEFAULTS.retries,retryDelayMs=PROVIDER_DEFAULTS.retryDelayMs,maxResponseBytes=PROVIDER_DEFAULTS.maxResponseBytes,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const base=new URL(baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw providerError('invalid_provider_url');
  const root=base.href.replace(/\/$/,'');
  if(!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1)throw providerError('invalid_provider_config','maxResponseBytes');
  async function once(path,init) {
    let reader,response,bytes,length=0;
    const controller=new AbortController(),cancel=()=>{if(reader)void reader.cancel().catch(()=>{});};
    const timer=setTimeout(()=>{controller.abort();cancel();},timeoutMs);
    try {
      response=await fetcher(root+path,{...init,redirect:'error',signal:controller.signal});
      reader=response.body?.getReader();
      if(Number(response.headers.get('content-length'))>maxResponseBytes)throw providerError('provider_response_too_large',{path});
      bytes=new Uint8Array(Math.min(65536,maxResponseBytes));
      if(reader)for(;;) {
        const {done,value}=await reader.read();
        if(controller.signal.aborted)throw providerError('provider_timeout',{path});
        if(done)break;
        // Count delivered bytes (including decompressed/chunked responses), BEFORE copying
        // or decoding. Never consume the rest of an oversized response to determine its size.
        if(value.byteLength>maxResponseBytes-length)throw providerError('provider_response_too_large',{path});
        if(length+value.byteLength>bytes.length) {
          const grown=new Uint8Array(Math.min(maxResponseBytes,Math.max(length+value.byteLength,bytes.length*2)));
          grown.set(bytes.subarray(0,length));bytes=grown;
        }
        bytes.set(value,length);length+=value.byteLength;
      }
    }catch(error) {
      const timedOut=controller.signal.aborted;
      cancel();controller.abort();
      if(error.code==='provider_response_too_large'||error.code==='provider_timeout')throw error;
      throw providerError(timedOut?'provider_timeout':'provider_unavailable',{path});
    }finally {clearTimeout(timer);reader?.releaseLock();}
    let text;try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));}
    catch {throw providerError('provider_non_json',{path});}
    if(!response.ok)throw providerError(response.status===429||response.status>=500?'provider_unavailable':'provider_http',{path,status:response.status});
    let body;try {body=JSON.parse(text);}catch {throw providerError('provider_non_json',{path});}
    if(!body||typeof body!=='object'||Array.isArray(body)||!('error' in body))throw providerError('provider_envelope',{path});
    if(body.error!==null&&body.error!==undefined){const error=classifyEnvelope(body.error);error.detail={...error.detail,path};throw error;}
    if(!('result' in body))throw providerError('provider_envelope',{path});
    return body.result;
  }
  async function request(path,init={}) {
    const idempotent=(init.method??'GET')==='GET';
    for(let attempt=0;;attempt++) {
      try {return await once(path,init);}
      catch(error) {
        // Broadcast is never retried here: the issuer owns identical-byte recovery.
        if(!idempotent||attempt>=retries||!RETRYABLE_TRANSPORT.has(error.message))throw error;
        await sleep(retryDelayMs*(attempt+1));
      }
    }
  }
  return {root,get:path=>request(path),
    post:(path,form)=>request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form).toString()})};
}
/** Recompute an 80-byte header hash from provider JSON (Xaya-style RPC fields). */
export function headerHash(header) {
  return bytesToHex(hash256(concat(le(header.version>>>0,4),hexToBytes(header.previousblockhash??ZERO).reverse(),
    hexToBytes(header.merkleroot).reverse(),le(header.time,4),hexToBytes(header.bits).reverse(),le(header.nonce,4))).reverse());
}
/** Bitcoin merkle root over display-order txids; duplicate txids are rejected (CVE-2012-2459). */
export function merkleRoot(txids) {
  if(!txids.length||new Set(txids).size!==txids.length)throw providerError('invalid_merkle');
  let level=txids.map(txid=>hexToBytes(txid).reverse());
  while(level.length>1){if(level.length%2)level.push(level.at(-1));const next=[];for(let i=0;i<level.length;i+=2)next.push(hash256(concat(level[i],level[i+1])));level=next;}
  return bytesToHex(level[0].slice().reverse());
}
/** Validate one /range block entry at an expected height; keep only verified compact fields. */
export function checkHeader(block,height) {
  const ok=block&&block.height===height&&HEX64.test(block.hash)&&HEX64.test(block.merkleroot)&&
    (height===0?!block.previousblockhash:HEX64.test(block.previousblockhash))&&Number.isSafeInteger(block.version)&&
    Number.isSafeInteger(block.time)&&block.time>=0&&Number.isSafeInteger(block.nonce)&&block.nonce>=0&&/^[a-f0-9]{8}$/.test(block.bits)&&
    Array.isArray(block.tx)&&block.tx.every(txid=>HEX64.test(txid))&&block.txcount===block.tx.length;
  if(!ok)throw providerError('invalid_header',{height});
  if(headerHash(block)!==block.hash)throw providerError('invalid_header',{height});
  if(merkleRoot(block.tx)!==block.merkleroot)throw providerError('invalid_merkle',{height});
  return {height,hash:block.hash,previous:block.previousblockhash??null,time:block.time,tx:[...block.tx]};
}
const isCoinbase=tx=>tx.inputs.length===1&&tx.inputs[0].txid===ZERO&&tx.inputs[0].index===0xffffffff;
function namedApp(tx,ownerScript) {
  return tx.outputs.some(output=>{try {const name=parseName(output.script);return name?.name===APP_NAME&&bytesToHex(name.payment)===ownerScript;}catch {return false;}});
}
function checkConfig(config) {
  const {appKey,markerKey,anchor,bootstrap}=config;
  if(!KEY.test(appKey)||!KEY.test(markerKey)||appKey===markerKey)throw providerError('invalid_provider_config','keys');
  if(!anchor||!Number.isSafeInteger(anchor.height)||anchor.height<0||!HEX64.test(anchor.hash))throw providerError('invalid_provider_config','anchor');
  if(bootstrap!==null&&!HEX64.test(bootstrap?.txid))throw providerError('invalid_provider_config','bootstrap');
  if(!Number.isSafeInteger(config.feePerByte)||config.feePerByte<1||config.feePerByte>FEE_POLICY.perByte)throw providerError('invalid_provider_config','feePerByte');
  if(!Number.isSafeInteger(config.markerAmount)||config.markerAmount<NETWORK.dust||!Number.isSafeInteger(config.nameAmount)||config.nameAmount<NETWORK.nameMinimum)throw providerError('invalid_provider_config','amounts');
  if(!HEX64.test(config.genesisHash)||typeof config.chain!=='string')throw providerError('invalid_provider_config','network');
  for(const field of ['pageSize','maxHistoryPages','rangeChunk','maxHeaderSpan','reorgRecheckDepth','acquisitionAttempts','maxFundingInputs','maxFundingCandidates'])
    if(!Number.isSafeInteger(config[field])||config[field]<1)throw providerError('invalid_provider_config',field);
  if(config.rangeChunk>100||config.maxFundingInputs>9||config.maxFundingCandidates>12)throw providerError('invalid_provider_config','bounds');
}

/** Factory for the issuer/reconcile chain interface. Requires pinned keys and a pinned header
 * anchor ({height,hash}, at least ten blocks before the bootstrap). bootstrap:null selects the
 * explicit first-registration state; {txid} selects established, lineage-authenticated state. */
export function createSpaceXpanseProvider(options={}) {
  const config={...PROVIDER_DEFAULTS,bootstrap:null,...options};checkConfig(config);
  const transport=config.transport??createTransport(config);
  const appKey=hexToBytes(config.appKey),markerKey=hexToBytes(config.markerKey),anchor=config.anchor;
  const appAddress=address(appKey),markerAddress=address(markerKey);
  const ownerScript=bytesToHex(payScript(appKey));
  const bootstrap=config.bootstrap&&{txid:config.bootstrap.txid,appKey:config.appKey,markerKey:config.markerKey};
  // Verified headers from the anchor; replaced only after a fully verified sync.
  let cache=[],networkChecked=false;
  const raws=new Map(); // txid -> raw hex, content-addressed and hash-verified, safe to reuse.
  const headerAt=height=>height>=anchor.height?cache[height-anchor.height]:undefined;

  async function tipInfo() {
    const info=await transport.get('/info');
    if(info?.chain!==config.chain)throw providerError('wrong_network',{chain:info?.chain??null});
    if(!HEX64.test(info.bestblockhash)||!Number.isSafeInteger(info.blocks)||info.blocks<0)throw providerError('provider_shape','info');
    if(!networkChecked){if(await transport.get('/hash/0')!==config.genesisHash)throw providerError('wrong_network','genesis');networkChecked=true;}
    return {height:info.blocks,hash:info.bestblockhash};
  }
  async function fetchHeaders(low,high) {
    const out=[];
    for(let top=high;top>=low;top-=config.rangeChunk) {
      const count=Math.min(config.rangeChunk,top-low+1),rows=await transport.get(`/range/${top}?offset=${count}`);
      // The server silently skips failed heights; any missing entry is a gap, never tolerated.
      if(!Array.isArray(rows)||rows.length!==count)throw providerError('header_gap',{top,count});
      rows.forEach((row,i)=>out.push(checkHeader(row,top-i)));
    }
    out.reverse();
    for(let i=1;i<out.length;i++)if(out[i].previous!==out[i-1].hash)throw providerError('reorg_detected',{height:out[i].height});
    return out;
  }
  /** Incremental anchored header sync with bounded reorg recheck and deep-reorg full refetch. */
  async function syncHeaders(tip) {
    if(tip.height<anchor.height)throw providerError('anchor_above_tip');
    if(tip.height-anchor.height+1>config.maxHeaderSpan)throw providerError('header_budget_exceeded');
    let next;
    if(cache.length&&cache[0].hash===anchor.hash) {
      const from=Math.max(anchor.height,Math.min(cache.at(-1).height,tip.height)-config.reorgRecheckDepth+1);
      const keep=cache.slice(0,from-anchor.height),fresh=await fetchHeaders(from,tip.height);
      next=!keep.length||keep.at(-1).hash===fresh[0].previous?[...keep,...fresh]:await fetchHeaders(anchor.height,tip.height);
    }else next=await fetchHeaders(anchor.height,tip.height);
    if(next[0].hash!==anchor.hash)throw providerError('anchor_mismatch');
    if(next.at(-1).hash!==tip.hash)throw providerError('tip_changed');
    cache=next;return cache;
  }
  async function transaction(txid) {
    if(!HEX64.test(txid))throw providerError('invalid_txid');
    const result=await transport.get(`/transaction/${txid}`);
    if(!result||typeof result.hex!=='string'||!/^([a-f0-9]{2})+$/.test(result.hex))throw providerError('provider_shape','transaction');
    if(bytesToHex(hash256(hexToBytes(result.hex)).reverse())!==txid)throw providerError('provider_raw_mismatch',{txid});
    raws.set(txid,result.hex);
    const included=HEX64.test(result.blockhash??'')&&Number.isSafeInteger(result.height)&&result.height>=0;
    return {txid,raw:result.hex,blockHash:included?result.blockhash:null,height:included?result.height:null};
  }
  async function rawOf(txid){return raws.get(txid)??(await transaction(txid)).raw;}
  /** One bounded marker-history page (newest first on rod-api-server); length gaps fail closed. */
  async function historyPage(offset) {
    const result=await transport.get(`/history/${markerAddress}?offset=${offset}`);
    if(!result||!Number.isSafeInteger(result.txcount)||result.txcount<0||!Array.isArray(result.tx)||result.tx.some(txid=>!HEX64.test(txid)))throw providerError('provider_shape','history');
    if(result.tx.length!==Math.max(0,Math.min(config.pageSize,result.txcount-offset)))throw providerError('history_page_gap',{offset});
    return {count:result.txcount,tx:[...result.tx]};
  }
  async function historyPages(addr) {
    const ids=[],seen=new Set();let count=null;
    for(let page=0;page<config.maxHistoryPages;page++) {
      const offset=page*config.pageSize,result=await transport.get(`/history/${addr}?offset=${offset}`);
      if(!result||!Number.isSafeInteger(result.txcount)||result.txcount<0||!Array.isArray(result.tx))throw providerError('provider_shape','history');
      if(count===null)count=result.txcount;else if(result.txcount!==count)throw providerError('history_changed');
      if(result.tx.length!==Math.max(0,Math.min(config.pageSize,count-offset)))throw providerError('history_page_gap',{offset});
      for(const txid of result.tx) {
        if(!HEX64.test(txid))throw providerError('provider_shape','history');
        // Offset paging has no snapshot token: a repeat means the list shifted under us.
        if(seen.has(txid))throw providerError('history_changed');seen.add(txid);ids.push(txid);
      }
      if(offset+config.pageSize>=count)return {ids,count,first:ids.slice(0,config.pageSize)};
    }
    throw providerError('history_budget_exceeded');
  }
  /** One stable-tip acquisition: tip, all marker pages, headers, raws/inclusion, prevouts, recheck. */
  async function acquireOnce() {
    const tip=await tipInfo(),history=await historyPages(markerAddress),headers=await syncHeaders(tip);
    const transactions=[],unconfirmed=[],previous=new Map();
    for(const txid of history.ids) {
      const tx=await transaction(txid);
      if(!tx.blockHash){unconfirmed.push(tx);continue;}
      if(tx.height>tip.height)throw providerError('tip_changed');
      const header=headerAt(tx.height);
      if(!header)throw providerError('history_before_anchor',{txid});
      if(header.hash!==tx.blockHash)throw providerError('reorg_detected',{txid});
      const index=header.tx.indexOf(txid);if(index<0)throw providerError('invalid_inclusion',{txid});
      transactions.push({raw:tx.raw,height:tx.height,index,blockHash:tx.blockHash});
    }
    // Prevouts only for candidate lineage (owned APP_NAME output): forged marker spam cannot inflate work.
    for(const observation of [...transactions,...unconfirmed]) {
      const tx=parseTransaction(observation.raw,{funding:true});
      if(isCoinbase(tx)||!namedApp(tx,ownerScript))continue;
      for(const input of tx.inputs)if(!previous.has(input.txid))previous.set(input.txid,await rawOf(input.txid));
    }
    const again=await tipInfo();if(again.hash!==tip.hash)throw providerError('tip_changed');
    const first=await transport.get(`/history/${markerAddress}?offset=0`);
    if(first?.txcount!==history.count||JSON.stringify(first?.tx)!==JSON.stringify(history.first))throw providerError('history_changed');
    return {complete:true,anchor:{...anchor},headers:headers.map(({height,hash,previous,time})=>({height,hash,previous,time})),
      transactions,previousTransactions:[...previous.values()],unconfirmed,
      evidence:{trust:PROVIDER_TRUST,provider:transport.root??null,tip,markerAddress,appAddress,txcount:history.count}};
  }
  /** Bounded retries on drift/reorg signals; otherwise fail closed with the precise code. */
  async function acquire() {
    for(let attempt=1;;attempt++) {
      try {return await acquireOnce();}
      catch(error) {
        if(!RETRYABLE_ACQUISITION.has(error.message))throw error;
        if(attempt>=config.acquisitionAttempts)throw providerError('history_unstable',{last:error.message,attempts:attempt});
      }
    }
  }
  /** Authenticated state: established lineage head or explicit first-registration state. */
  async function state() {
    const observed=await acquire();
    const pendingOf=head=>observed.unconfirmed.some(({raw})=>{const tx=parseTransaction(raw,{funding:true});
      return namedApp(tx,ownerScript)||(head&&tx.inputs.some(input=>input.txid+':'+input.index===head));});
    if(!bootstrap) {
      // Any owned app-name operation means a registration exists; its txid must be pinned first.
      const registered=[...observed.transactions,...observed.unconfirmed].some(({raw})=>namedApp(parseTransaction(raw,{funding:true}),ownerScript));
      if(registered)throw providerError('bootstrap_pin_required');
      // The provider exposes no name lookup: global absence of the name cannot be shown here.
      if(!config.allowUnprovenNameAbsence)throw providerError('name_absence_unverified');
      const times=observed.headers.slice(-11).map(header=>header.time);
      return {mode:'first_registration',observed,head:null,epoch:epoch(medianTime(times)),pending:false,lineage:[]};
    }
    const result=reconstruct({...observed,bootstrap});
    return {mode:'established',observed,result,head:result.head,epoch:result.epoch,pending:pendingOf(result.head),lineage:result.lineage};
  }
  async function confirmedUnspent(tip) {
    const rows=await transport.get(`/unspent/${appAddress}`);
    if(!Array.isArray(rows))throw providerError('provider_shape','unspent');
    return rows.filter(row=>{
      if(!row||!HEX64.test(row.txid)||!Number.isSafeInteger(row.index)||row.index<0||!Number.isSafeInteger(row.value)||row.value<0||!Number.isSafeInteger(row.height))
        throw providerError('provider_shape','unspent');
      return row.height>0&&row.height<=tip.height;
    });
  }
  /** Load and authenticate one funding UTXO from its exact raw; null when not spendable as funding. */
  async function fundingInput(row,tip) {
    const tx=await transaction(row.txid),parsed=parseTransaction(tx.raw,{funding:true}),output=parsed.outputs[row.index];
    if(!output||output.amount!==row.value)throw providerError('provider_utxo_mismatch',{txid:row.txid});
    if(!tx.blockHash||tx.height!==row.height)throw providerError('reorg_detected',{txid:row.txid});
    const header=headerAt(tx.height)??(await fetchHeaders(tx.height,tx.height))[0];
    if(header.hash!==tx.blockHash||!header.tx.includes(row.txid))throw providerError('reorg_detected',{txid:row.txid});
    if(bytesToHex(output.script)!==ownerScript)return null;
    if(isCoinbase(parsed)&&tip.height-tx.height+1<config.coinbaseMaturity)return null;
    return {txid:row.txid,index:row.index,amount:output.amount,script:ownerScript,previousRaw:tx.raw};
  }
  /** Value-first discovery is bounded separately from the nine selected funding inputs.
   * Untrusted values only order candidates; exact raw, inclusion, script and maturity
   * checks decide spendability. Both readiness and preparation use this same path. */
  async function selectFunding(tip,head,accept) {
    const rows=(await confirmedUnspent(tip)).filter(row=>row.txid+':'+row.index!==head)
      .sort((a,b)=>b.value-a.value||a.height-b.height||(a.txid<b.txid?-1:a.txid>b.txid?1:0)||a.index-b.index);
    const selected=[],seen=new Set();let inspected=0;
    for(const row of rows) {
      if(selected.length>=config.maxFundingInputs||inspected>=config.maxFundingCandidates)break;
      const outpoint=row.txid+':'+row.index;if(seen.has(outpoint))continue;
      seen.add(outpoint);inspected++;
      const input=await fundingInput(row,tip);if(!input)continue;
      selected.push(input);
      const result=accept(selected);if(result)return result;
    }
    throw providerError('funds_unavailable');
  }
  /** Deterministic value-aware funding with fee <= policy, folded sub-dust change. */
  async function fund(claim,current) {
    const tip=current.observed.evidence.tip,operation=current.head?'update':'register';
    const receipt={...parseCanonical(claim.bytes,7),a:'A'.repeat(87)};
    const inputs=[];let nameAmount=config.nameAmount;
    if(current.head) {
      const [txid,index]=current.head.split(':'),entry=current.lineage.at(-1);
      if(entry?.txid!==txid)throw providerError('reconciliation_required');
      const output=parseTransaction(entry.raw).outputs[Number(index)];
      inputs.push({txid,index:Number(index),amount:output.amount,script:bytesToHex(output.script),previousRaw:entry.raw});nameAmount=output.amount;
    }
    const plan=()=>{
      const total=inputs.reduce((sum,input)=>sum+input.amount,0);
      const shape={version:2,inputs:inputs.map(({txid,index})=>({txid,index})),locktime:0,outputs:[{amount:nameAmount,script:nameScript(operation,receipt,appKey)},
        {amount:config.markerAmount,script:payScript(markerKey)},{amount:NETWORK.dust,script:payScript(appKey)}]};
      let fee=(serialize(shape,inputs.map(()=>new Uint8Array())).length+inputs.length*SIGNED_INPUT_BYTES)*config.feePerByte;
      const change=total-fee-config.markerAmount-nameAmount;
      if(change<0)return null;
      if(change<NETWORK.dust)fee+=change;
      const prepared={operation,fee,markerAmount:config.markerAmount,nameAmount,inputs:inputs.map(input=>({...input}))};
      try {buildTransaction(prepared,receipt,appKey,markerKey);return prepared;}
      catch(error){if(['funds_unavailable','excessive_fee','excessive_fee_rate'].includes(error.message))return null;throw error;}
    };
    return selectFunding(tip,current.head,selected=>{inputs.push(selected.at(-1));return plan();});
  }
  return Object.freeze({
    config:Object.freeze({...config,transport:undefined,fetch:undefined,appAddress,markerAddress}),
    // The durable Worker follower persists verified observations between bounded invocations.
    // These are adapter methods, not HTTP endpoints or generic RPC forwarding.
    primitives:Object.freeze({tipInfo,fetchHeaders,transaction,rawOf,historyPage,fund,fundingInput,selectFunding,confirmedUnspent,
      ownedName:tx=>namedApp(tx,ownerScript),ownerScript,appAddress,markerAddress}),
    /** Issuer: authenticated head/epoch plus fully raw-authenticated prepared inputs. */
    async prepare(claim) {
      const current=await state();
      if(current.pending)throw providerError('unconfirmed_pending');
      const prepared=await fund(claim,current);
      return {epoch:current.epoch,head:current.head,prepared,mode:current.mode,evidence:current.observed.evidence};
    },
    /** Issuer pre-barrier recheck: same head/epoch, no pending lineage, inputs still confirmed-unspent. */
    async validate(observation) {
      const current=await state();
      if(current.pending||current.epoch!==observation.epoch||current.head!==observation.head)return false;
      const unspent=new Set((await confirmedUnspent(current.observed.evidence.tip)).map(row=>row.txid+':'+row.index));
      return observation.prepared.inputs.every(input=>{const outpoint=input.txid+':'+input.index;
        return outpoint===current.head||(input.script===ownerScript&&unspent.has(outpoint));});
    },
    /** Read-only investigation of an uncertain prior broadcast; never triggers a new spend. */
    async lookup(txid,inputs=[]) {
      let tx;
      try {tx=await transaction(txid);}
      catch(error) {
        if(error.message!=='not_found')throw error;
        const tip=await tipInfo(),unspent=new Set((await confirmedUnspent(tip)).map(row=>row.txid+':'+row.index));
        const spent=inputs.filter(input=>input.script===ownerScript&&!unspent.has(input.txid+':'+input.index)).map(input=>input.txid+':'+input.index);
        return {state:spent.length?'conflict_suspected':'unknown',txid,spent};
      }
      if(!tx.blockHash)return {state:'mempool',txid};
      const tip=await tipInfo();await syncHeaders(tip);
      const header=headerAt(tx.height);
      if(header&&header.hash!==tx.blockHash)throw providerError('reorg_detected',{txid});
      return {state:'included',txid,height:tx.height,blockHash:tx.blockHash,confirmations:tip.height-tx.height+1,index:header?header.tx.indexOf(txid):null};
    },
    /** Submit exact persisted bytes once (no transport retry); identical-byte duplicates map to txid. */
    async broadcast(raw) {
      const txid=parseTransaction(raw).txid;
      try {
        const result=await transport.post('/broadcast',{raw});
        if(result!==txid)throw providerError('broadcast_txid_mismatch');
        return result;
      }catch(error) {
        if(error.message==='provider_error'&&ALREADY_KNOWN.test(error.detail?.message??''))return txid;
        throw error;
      }
    },
    /** Reconcile source: requires the pinned bootstrap; returns provider-anchored history. */
    async history() {
      if(!bootstrap)throw providerError('bootstrap_pin_required');
      return {...await acquire(),bootstrap};
    },
    /** Network/tip status only; no history or signing side effects. */
    async status() {return {tip:await tipInfo(),appAddress,markerAddress,mode:bootstrap?'established':'first_registration',trust:PROVIDER_TRUST};}
  });
}
