import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeWif,base58check,utf8,bytesToHex,hexToBytes } from './receipt.js';
import { NETWORK,FEE_POLICY,APP_NAME,parseTransaction,parseName,payScript,verifyInput } from './chain.js';
import { createSpaceXpanseProvider,PROVIDER_DEFAULTS } from './provider.js';
import { reconstruct,deriveReceipt } from './reconcile.js';
import { epoch,medianTime } from './profile.js';
import { advance } from './issuer.js';
import { publisherReadiness } from './storage.js';

const RECHECK=30,CHUNK=100,CHECKPOINT_LAG=60;
const FINITE_FAILURES=new Set(['finite_scope_required','claim_outside_scope','transaction_budget_exhausted','broadcast_budget_exhausted','spend_budget_exhausted','invalid_budget_plan']);
/** Public-only hash-to-curve marker: domain-separated from receipt signatures and funding.
 * No known private scalar is generated or required; never use this address for funding. */
export function deriveMarker(appKey) {
  for(let counter=0;counter<256;counter++) {
    const key='02'+bytesToHex(sha256(utf8('huarong/marker/main/g/huarong-lb/v1\0'+appKey+'\0'+counter)));
    try {secp256k1.Point.fromHex(key);return key;}catch {}
  }
  throw Error('invalid_provider_config');
}
/** Only runtime bindings are inspected. Retired bindings and secret files are never consulted. */
export function publisherConfig(bindings={}) {
  if(bindings.HD1_PUBLISHER==='false')return {code:'issuance_disabled'};
  if(!bindings.ROD_APP_WIF)return {code:'issuer_not_configured'};
  if(!bindings.SUPABASE_URL||!bindings.SUPABASE_SERVICE_KEY)return {code:'storage_not_configured'};
  if(typeof bindings.HD1_RATE_HMAC_KEY!=='string'||utf8(bindings.HD1_RATE_HMAC_KEY).length<32||utf8(bindings.HD1_RATE_HMAC_KEY).length>256)return {code:'rate_secret_not_configured'};
  try {
    const wif=bindings.ROD_APP_WIF;
    if(typeof wif!=='string'||wif.length>52)throw Error('invalid_issuer_wif');
    const secret=decodeWif(wif,NETWORK.wif),appKey=bytesToHex(secp256k1.getPublicKey(secret));
    // Signing uses compressed P2PKH. Never silently spend a legacy uncompressed address.
    if(base58check(Uint8Array.from([NETWORK.wif,...secret,1]))!==wif)return {code:'funding_compression_incompatible'};
    const markerKey=bindings.ROD_MARKER_KEY||deriveMarker(appKey);
    let anchor=null,bootstrap=null;
    if(bindings.ROD_ANCHOR_HEIGHT!==undefined||bindings.ROD_ANCHOR_HASH!==undefined) {
      anchor={height:Number(bindings.ROD_ANCHOR_HEIGHT),hash:bindings.ROD_ANCHOR_HASH};
      if(!Number.isSafeInteger(anchor.height)||anchor.height<0||!/^[a-f0-9]{64}$/.test(anchor.hash??''))throw Error();
    }
    if(bindings.ROD_BOOTSTRAP_TXID){bootstrap=bindings.ROD_BOOTSTRAP_TXID;if(!/^[a-f0-9]{64}$/.test(bootstrap)||!anchor)throw Error();}
    // Factory validation is reused without performing any network operation.
    createSpaceXpanseProvider({appKey,markerKey,anchor:anchor??{height:0,hash:PROVIDER_DEFAULTS.genesisHash},bootstrap:bootstrap?{txid:bootstrap}:null,
      baseUrl:bindings.ROD_API_URL||PROVIDER_DEFAULTS.baseUrl});
    new URL(bindings.ROD_API_URL||PROVIDER_DEFAULTS.baseUrl);
    return {secret,appKey,markerKey,anchor,bootstrap,baseUrl:bindings.ROD_API_URL||PROVIDER_DEFAULTS.baseUrl};
  }catch {return {code:'invalid_publisher_configuration'};}
}
/** Fenced runtime writes never proceed on an ambiguous response. */
async function mutate(storage,operation,payload) {
  const result=await storage.rpc(operation,payload);
  if(result?.code&&result.version===undefined)throw Error(result.code);
  return result;
}
/** Authenticate a retained pre-003 registration journal before pinning it on upgrade. */
function journalBootstrap(claim,config) {
  const tx=parseTransaction(claim.raw),key=hexToBytes(config.appKey),marker=bytesToHex(payScript(hexToBytes(config.markerKey)));
  const names=tx.outputs.map(output=>parseName(output.script)).filter(Boolean);
  if(tx.txid!==claim.txid||names.length!==1||names[0].operation!=='register'||names[0].name!==APP_NAME||
    bytesToHex(names[0].payment)!==bytesToHex(payScript(key))||names[0].value!==claim.receipt||
    !tx.outputs.some(output=>bytesToHex(output.script)===marker)||deriveReceipt(claim.receipt,config.appKey).id!==claim.id)throw Error('bootstrap_pin_required');
  tx.inputs.forEach((input,index)=>{
    const saved=claim.prepared.inputs.find(row=>row.txid===input.txid&&row.index===input.index);
    const previous=parseTransaction(saved?.previousRaw,{funding:true});
    if(previous.txid!==input.txid||!previous.outputs[input.index])throw Error('bootstrap_pin_required');
    verifyInput(tx,index,previous.outputs[input.index].script,key);
  });
  return tx.txid;
}
/** Reconstruct only the rolling suffix; the immutable bootstrap remains in trusted SQL state. */
function snapshotOf(document,config,bootstrap,tip=document.headers.at(-1)) {
  const headers=document.headers.filter(row=>row.height<=tip.height);
  const transactions=document.transactions.filter(row=>row.height<=tip.height);
  if(!bootstrap||(!document.checkpoint&&!transactions.some(row=>parseTransaction(row.raw).txid===bootstrap))) {
    if(bootstrap&&!config.allowUnobservedBootstrap)throw Error('bootstrap_missing');
    if(document.checkpoint||transactions.some(row=>config.ownedName(parseTransaction(row.raw,{funding:true}))))throw Error('bootstrap_pin_required');
    return {receipts:[],pending:[],invalid:[],lineage:[],head:null,epoch:epoch(medianTime(headers.slice(-11).map(row=>row.time))),
      height:tip.height,hash:tip.hash,finalizedEpochs:[]};
  }
  return reconstruct({complete:true,anchor:{height:headers[0].height,hash:headers[0].hash},headers,transactions,
    previousTransactions:document.previous,checkpoint:document.checkpoint,
    bootstrap:{txid:bootstrap,appKey:config.appKey,markerKey:config.markerKey}});
}
/** Persisted, resumable acquisition: one header chunk, one history page, one raw observation.
 * All trust is the single provider's stable responses, not independently verified consensus.
 * Known prefix overlap supports incremental newest-first discovery; full count is rechecked. */
async function acquire(runtime,provider,storage,job) {
  const api=provider.primitives,document=structuredClone(runtime.document),tip=await api.tipInfo();
  const headers=document.headers??[],anchor=document.headerAnchor??runtime.config.anchor;
  const from=headers.length?Math.max(headers[0].height,Math.min(headers.at(-1).height,tip.height)-RECHECK+1):anchor.height;
  const high=Math.min(tip.height,from+CHUNK-1),fresh=await api.fetchHeaders(from,high);
  const keep=headers.filter(row=>row.height<from);
  if((keep.length&&keep.at(-1).hash!==fresh[0].previous)||(!keep.length&&fresh[0].hash!==(document.checkpoint?headers[0].hash:anchor.hash)))throw Error('checkpoint_mismatch');
  if(document.checkpoint&&fresh.some(row=>row.height===document.checkpoint.height&&row.hash!==document.checkpoint.hash))throw Error('checkpoint_mismatch');
  const prior=new Map(headers.map(row=>[row.height,row.hash]));
  const changed=fresh.find(row=>prior.has(row.height)&&prior.get(row.height)!==row.hash);
  if(changed&&document.checkpoint&&changed.height<=document.checkpoint.height)throw Error('checkpoint_mismatch');
  document.headers=[...keep,...fresh];
  document.transactions??=[];document.previous??=[];document.observations??={};document.ids??=[];
  if(high<tip.height) {
    await mutate(storage,'save',{job,version:runtime.version,document});return null;
  }
  if(fresh.at(-1).hash!==tip.hash)throw Error('history_changed');
  const first=await api.historyPage(0);
  let scan=document.scan;
  if(!scan||scan.count!==first.count||JSON.stringify(scan.first)!==JSON.stringify(first.tx))scan={count:first.count,first:first.tx,offset:0,ids:[]};
  const page=scan.offset===0?first:await api.historyPage(scan.offset);
  if(page.count!==scan.count)throw Error('history_changed');
  if(page.tx.some(id=>scan.ids.includes(id)))throw Error('history_changed');
  scan.ids.push(...page.tx);scan.offset+=page.tx.length;
  // A stable known suffix may be reused, but only with exact count and order agreement.
  const overlap=page.tx.find(id=>document.ids.includes(id));
  if(overlap) {
    const merged=[...scan.ids.slice(0,scan.ids.indexOf(overlap)),...document.ids.slice(document.ids.indexOf(overlap))];
    if(merged.length===scan.count&&new Set(merged).size===merged.length&&scan.ids.every((id,index)=>merged[index]===id)){
      scan.ids=merged;scan.offset=scan.count;
    }
  }
  document.scan=scan;
  if(scan.offset<scan.count){await mutate(storage,'save',{job,version:runtime.version,document});return null;}
  if(scan.ids.length!==scan.count)throw Error('history_changed');
  // Removed observations are retained as evidence, but not attributed to the new canonical
  // suffix. The 002 rebuild records removed lineage permanently and keeps issuance paused.
  document.transactions=document.transactions.filter(row=>scan.ids.includes(parseTransaction(row.raw,{funding:true}).txid));
  const checkpointHeight=document.checkpoint?.height??-1;
  const todo=scan.ids.filter(id=>{
    const old=document.observations[id];
    const header=old&&document.headers.find(row=>row.height===old.height);
    return !old||old.height===null&&old.owned&&old.checkedHash!==tip.hash||
      old.height>checkpointHeight&&header&&old.blockHash!==header.hash;
  }).sort((a,b)=>Number(!!document.observations[a])-Number(!!document.observations[b]));
  for(const id of todo.slice(0,1)) {
    const observed=await api.transaction(id),tx=parseTransaction(observed.raw,{funding:true});
    const owned=api.ownedName(tx);
    if(observed.height!==null&&observed.height<document.headers[0].height) {
      if(owned&&observed.height>checkpointHeight)throw Error('bootstrap_pin_required');
    }else if(observed.height!==null) {
      const header=document.headers.find(row=>row.height===observed.height);
      if(!header||header.hash!==observed.blockHash||!header.tx.includes(id))throw Error('reorg_detected');
      document.transactions=document.transactions.filter(row=>parseTransaction(row.raw,{funding:true}).txid!==id);
      if(owned)document.transactions.push({raw:observed.raw,height:observed.height,index:header.tx.indexOf(id),blockHash:observed.blockHash});
    }else document.transactions=document.transactions.filter(row=>parseTransaction(row.raw,{funding:true}).txid!==id);
    if(owned)for(const input of tx.inputs) {
      if(!document.previous.some(raw=>parseTransaction(raw,{funding:true}).txid===input.txid))document.previous.push(await api.rawOf(input.txid));
    }
    document.observations[id]={height:observed.height,blockHash:observed.blockHash,checkedHash:tip.hash,owned,raw:owned?observed.raw:undefined};
  }
  const end=await api.tipInfo(),last=await api.historyPage(0);
  if(end.hash!==tip.hash||JSON.stringify(last)!==JSON.stringify(first))throw Error('history_changed');
  const unfinished=todo.length>1;
  document.ids=scan.ids;document.scan=null;
  if(unfinished){await mutate(storage,'save',{job,version:runtime.version,document});return null;}
  // A removed checkpoint operation cannot be replayed by this bounded suffix: fail closed.
  for(const row of document.checkpoint?.lineage??[])if(!document.ids.includes(row.txid))throw Error('checkpoint_mismatch');
  const config={...runtime.config,ownedName:api.ownedName,allowUnobservedBootstrap:!!runtime.bootstrap_claim};
  if(!runtime.bootstrap&&Object.values(document.observations).some(row=>row.owned))throw Error('bootstrap_pin_required');
  const snapshot=snapshotOf(document,config,runtime.bootstrap);
  const unconfirmed=document.ids.some(id=>document.observations[id]?.height===null&&document.observations[id]?.owned);
  // Rolling checkpoint is sixty blocks behind the verified tip. Reorgs crossing it fail closed,
  // retaining all journals. Ten predecessor timestamps preserve exact MTP/weekly-close semantics.
  const cut=tip.height-CHECKPOINT_LAG;
  if(runtime.bootstrap&&snapshot.head&&cut>(document.checkpoint?.height??anchor.height+10)&&document.headers.some(row=>row.height===cut)) {
    const header=document.headers.find(row=>row.height===cut),checkpoint=snapshotOf(document,config,runtime.bootstrap,header);
    if(checkpoint.head) {
      document.checkpoint={...checkpoint,bootstrap:runtime.bootstrap};
      document.headers=document.headers.filter(row=>row.height>=cut-10);
      document.headerAnchor={height:document.headers[0].height,hash:document.headers[0].hash};
      document.transactions=document.transactions.filter(row=>row.height>cut);
      const required=new Set(document.transactions.flatMap(row=>parseTransaction(row.raw).inputs.map(input=>input.txid)));
      if(checkpoint.lineage.length)required.add(checkpoint.lineage.at(-1).txid);
      const previous=new Map();
      for(const raw of [...document.previous,...checkpoint.lineage.map(row=>row.raw)]) {
        const txid=parseTransaction(raw,{funding:true}).txid;
        if(required.has(txid))previous.set(txid,raw);
      }
      document.previous=[...previous.values()];
    }
  }
  // Unused installations also roll forward; no need to retain years of empty headers before
  // first consent. Original anchor stays immutable in config, this link-derived cursor is durable.
  if(!runtime.bootstrap&&document.headers.length>CHUNK) {
    document.headers=document.headers.slice(-(CHECKPOINT_LAG+11));
    document.headerAnchor={height:document.headers[0].height,hash:document.headers[0].hash};
  }
  runtime=await mutate(storage,'save',{job,version:runtime.version,document});
  return {runtime,snapshot,unconfirmed,tip,api};
}
/** One scheduler tick, safe under overlap, timeout and isolate restart. Never invoked by GET.
 * Job leases fence acquisition only; the SQL signing barrier remains non-expiring. */
export async function runPublisher(storage,config,{fetch:fetcher=globalThis.fetch,providerOptions={},scope=null}={}) {
  if(config.code)return {code:config.code};
  const capability=await publisherReadiness(storage);
  if(capability.code==='schema_upgrade_required')return {code:capability.code};
  const backend=storage;
  storage={read:()=>backend.read(),rpc:(operation,payload={})=>backend.rpc(operation,{...payload,scope})};
  const job=crypto.randomUUID();let runtime=await storage.rpc('job',{owner:job});
  if(runtime.code==='job_busy')return {code:'job_busy'};
  if(!runtime.owner)return {code:FINITE_FAILURES.has(runtime.code)?runtime.code:'publisher_unavailable'};
  let calls=0;const deadline=Date.now()+55000;
  const boundedFetch=(...args)=>{if(++calls>36||Date.now()>deadline)throw Error('provider_unavailable');return fetcher(...args);};
  const makeProvider=(anchor,bootstrap)=>createSpaceXpanseProvider({appKey:config.appKey,markerKey:config.markerKey,anchor,
    bootstrap:bootstrap?{txid:bootstrap}:null,baseUrl:config.baseUrl,fetch:boundedFetch,retries:0,acquisitionAttempts:1,...providerOptions});
  try {
    if(runtime.config&&(runtime.config.appKey!==config.appKey||runtime.config.markerKey!==config.markerKey||runtime.config.baseUrl!==config.baseUrl||
      config.bootstrap&&config.bootstrap!==runtime.bootstrap||config.anchor&&JSON.stringify(config.anchor)!==JSON.stringify(runtime.config.anchor)))throw Error('identity_configuration_mismatch');
    if(runtime.config) {
      const current=await storage.read(),active=current.claims.find(row=>row.id===current.coordinator.active);
      if(active&&['signing_started','signing_unknown'].includes(active.state))throw Error('signing_unknown');
    }
    if(!runtime.config) {
      const probe=makeProvider(config.anchor??{height:0,hash:PROVIDER_DEFAULTS.genesisHash},config.bootstrap),api=probe.primitives;
      const tip=await api.tipInfo(),height=config.anchor?.height??Math.max(0,tip.height-10),[header]=await api.fetchHeaders(height,height);
      let anchor=config.anchor??{height,hash:header.hash};if(header.hash!==anchor.hash)throw Error('anchor_mismatch');
      const state=await storage.read(),registrations=state.claims.filter(row=>row.raw&&row.prepared?.operation==='register');
      if(registrations.length>1)throw Error('bootstrap_pin_required');
      const own=registrations[0],bootstrap=config.bootstrap??(own?journalBootstrap(own,config):null);
      if(own&&config.bootstrap&&config.bootstrap!==journalBootstrap(own,config))throw Error('identity_configuration_mismatch');
      if(own&&!config.anchor) {
        const observed=await api.transaction(own.txid).catch(error=>{if(error.message!=='not_found')throw error;return null;});
        if(observed?.height!==null&&observed?.height!==undefined) {
          const start=Math.max(0,observed.height-10),[before]=await api.fetchHeaders(start,start);
          anchor={height:start,hash:before.hash};
        }
      }
      runtime=await mutate(storage,'initialize',{job,config:{appKey:config.appKey,markerKey:config.markerKey,baseUrl:config.baseUrl,anchor},
        bootstrap,bootstrap_claim:own?.id??null,document:{headers:[],transactions:[],previous:[],ids:[],observations:{}}});
    }
    const provider=makeProvider(runtime.config.anchor,runtime.bootstrap),acquired=await acquire(runtime,provider,storage,job);
    if(!acquired)return {code:'initial_sync'};
    runtime=acquired.runtime;
    const {snapshot,api,tip,unconfirmed}=acquired;
    if(snapshot.head&&!unconfirmed) {
      const unspent=await api.confirmedUnspent(tip);
      if(!unspent.some(row=>row.txid+':'+row.index===snapshot.head))throw Error('conflict_suspected');
    }
    const state=await storage.read();
    const active=state.claims.find(row=>row.id===state.coordinator.active);
    if(unconfirmed&&Object.entries(runtime.document.observations).some(([id,row])=>row.owned&&row.height===null&&id!==active?.txid))throw Error('conflict_suspected');
    if(active&&['signing_started','signing_unknown'].includes(active.state))throw Error('signing_unknown');
    if(active?.raw&&active.attempts>=4&&!snapshot.lineage.some(row=>row.txid===active.txid))throw Error('retry_exhausted');
    runtime=await mutate(storage,'synchronize',{job,version:runtime.version,revision:state.coordinator.revision,
      epoch:snapshot.epoch,head:snapshot.head,snapshot:{...snapshot,stale:false}});
    const claim=await storage.rpc('next');
    if(claim&&['signing_started','signing_unknown'].includes(claim.state))throw Error('signing_unknown');
    if(claim?.raw&&claim.attempts>=4&&!['included','confirmed'].includes(claim.state))throw Error('retry_exhausted');
    if(!runtime.ready)return {code:runtime.code};
    const chain={
      prepare:async row=>{
        if(unconfirmed)throw Error('unconfirmed_pending');
        const current={head:snapshot.head,lineage:snapshot.lineage,observed:{evidence:{tip}}};
        return {epoch:snapshot.epoch,head:snapshot.head,prepared:await api.fund(row,current)};
      },
      validate:async observation=>{
        const fresh=await api.tipInfo();if(fresh.hash!==tip.hash)return false;
        const first=await api.historyPage(0),observed=runtime.document.ids.slice(0,10);
        if(first.count!==runtime.document.ids.length||JSON.stringify(first.tx)!==JSON.stringify(observed))return false;
        const unspent=new Set((await api.confirmedUnspent(fresh)).map(row=>row.txid+':'+row.index));
        return observation.prepared.inputs.every(input=>unspent.has(input.txid+':'+input.index));
      },
      lookup:async(txid,inputs)=>{
        try {
          const observed=await api.transaction(txid);
          if(observed.height!==null)return {state:'included',txid};
          return {state:'mempool',txid};
        }catch(error) {
          if(error.message!=='not_found')throw error;
          const unspent=new Set((await api.confirmedUnspent(await api.tipInfo())).map(row=>row.txid+':'+row.index));
          if(inputs.some(input=>!unspent.has(input.txid+':'+input.index)))throw Error('conflict_suspected');
          return {state:'unknown',txid};
        }
      },
      broadcast:raw=>provider.broadcast(raw)
    };
    if(claim) {
      const scoped={read:()=>storage.read(),rpc:(operation,payload={})=>storage.rpc(operation,{...payload,job})};
      const result=await advance(scoped,chain,config.secret,hexToBytes(config.markerKey),claim.id);
      if(result.code&& !['retry_later','signer_busy','stale_state'].includes(result.code))throw Error(result.code);
      return {code:result.code??result.state};
    }
    // Preflight exact spendable raws (including maturity) without signing. The conservative
    // reserve uses the existing fee ceiling; split funding is valid within the same input bound.
    const reserve=(snapshot.head?0:NETWORK.nameMinimum)+FEE_POLICY.maximum+NETWORK.dust;
    await api.selectFunding(tip,snapshot.head,inputs=>inputs.reduce((total,input)=>total+input.amount,0)>=reserve);
    return {code:'ready'};
  }catch(error) {
    try {await storage.rpc('job_error',{job,code:error.message});}catch {}
    return {code:FINITE_FAILURES.has(error.message)?error.message:'publisher_unavailable'};
  }finally {
    try {await storage.rpc('job_done',{job});}catch {}
  }
}
