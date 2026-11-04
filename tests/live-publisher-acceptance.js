// Explicit runtime-only acceptance runner; no dotenv, config-file or secret-file reads.
// Default: node tests/live-publisher-acceptance.js (server-only reads + no broadcast).
// Authorized finite publication: --publish --name=g/huarong-lb --max-broadcasts=1
// --max-fee-units=100000 --max-new-locked-units=1000600 --ticks=2
// Resume the immutable installed scope: --resume-scope=<returned scope_id> [--ticks=1..10].
// Resume accepts no new budgets/name/--publish, uses the same durable job lock, and
// can reconcile inclusion/final6 after all broadcast authority has been consumed.
// Existing queued consented claims only. Never creates/submits a player claim.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SupabaseStorage,publisherReadiness } from '../leaderboard/storage.js';
import { publisherConfig,runPublisher } from '../leaderboard/publisher.js';
import { parseTransaction,NETWORK,APP_NAME } from '../leaderboard/chain.js';
import { createSpaceXpanseProvider,PROVIDER_DEFAULTS } from '../leaderboard/provider.js';
import { inspectRecovery,installRecovery } from '../leaderboard/recovery.js';
import { recoveryReadiness } from '../leaderboard/storage.js';

/** Separate strict operator grammar. Installation never signs; only matching resume can tick. */
async function recoveryAcceptance(bindings,args,fetcher) {
  const options=new Map(),flags=new Set(['--inspect-recovery','--install-recovery']);
  for(const arg of args) {
    const [key,value,...rest]=arg.split('=');
    if(options.has(key)||rest.length||(flags.has(key)?value!==undefined:!value))throw Error('invalid_recovery_arguments');
    options.set(key,value??true);
  }
  const inspect=options.has('--inspect-recovery'),install=options.has('--install-recovery'),resume=options.get('--resume-recovery');
  if(Number(inspect)+Number(install)+Number(!!resume)!==1)throw Error('invalid_recovery_arguments');
  const installKeys=['--install-recovery','--recovery-id','--original-scope','--claim-id','--original-txid','--generation',
    '--conflict-txid','--consent-claim','--name','--max-broadcasts','--max-fee-units','--max-new-locked-units'];
  const allowed=inspect?['--inspect-recovery','--raw-txid']:install?installKeys:['--resume-recovery','--ticks'];
  if([...options.keys()].some(key=>!allowed.includes(key))||install&&installKeys.some(key=>!options.has(key)))throw Error('invalid_recovery_arguments');
  const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value??'');
  const hex=value=>/^[a-f0-9]{64}$/.test(value??'');
  const integer=(key,min,max)=>{
    const value=options.get(key);
    if(!/^(0|[1-9][0-9]*)$/.test(value??'')||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error('invalid_recovery_arguments');
    return Number(value);
  };
  if(resume&&!uuid(resume)||install&&(!uuid(options.get('--recovery-id'))||!uuid(options.get('--original-scope'))||
    ['--claim-id','--original-txid','--conflict-txid','--consent-claim'].some(key=>!hex(options.get(key)))||options.get('--name')!==APP_NAME))throw Error('invalid_recovery_arguments');
  const ticks=options.has('--ticks')?integer('--ticks',1,10):1;
  let envelope;
  if(install)envelope={id:options.get('--recovery-id'),scope_id:options.get('--original-scope'),claim_id:options.get('--claim-id'),
    original_txid:options.get('--original-txid'),generation:integer('--generation',1,Number.MAX_SAFE_INTEGER),
    conflict_txid:options.get('--conflict-txid'),consent_claim:options.get('--consent-claim'),name:APP_NAME,max_signings:1,
    max_broadcasts:integer('--max-broadcasts',1,4),max_fee_units:integer('--max-fee-units',1,100000),max_new_locked_units:integer('--max-new-locked-units',0,1000600)};
  const storage=new SupabaseStorage(bindings.SUPABASE_URL,bindings.SUPABASE_SERVICE_KEY,fetcher);
  if(inspect)return inspectRecovery(storage,options.get('--raw-txid')??null);
  const config=publisherConfig(bindings);if(config.code)return {ok:false,code:config.code};
  if(install)return installRecovery(storage,config,envelope);
  if((await recoveryReadiness(storage)).code==='recovery_schema_upgrade_required')return {ok:false,code:'recovery_schema_upgrade_required'};
  const journal=await storage.rpc('recovery_inspect');
  if(journal?.id!==resume)return {ok:false,code:'recovery_mismatch',broadcasts:0};
  const outcomes=[],diagnostics=[];let broadcasts=0;
  const guarded=async(url,init={})=>{
    if((init.method??'GET')!=='GET') {
      if(new URL(url).pathname!=='/broadcast')throw Error('broadcast_not_authorized');
      const current=await storage.rpc('recovery_inspect'),raw=new URLSearchParams(init.body).get('raw');
      if(current?.id!==resume||current.attempt.raw!==raw||parseTransaction(raw).txid!==current.attempt.txid||
        current.broadcasts<1||current.transactions!==1||current.broadcasts>current.envelope.max_broadcasts)throw Error('scoped_outbox_required');
      broadcasts++;
    }
    return fetcher(url,init);
  };
  const progress=new Set(['initial_sync','broadcast_pending','broadcast_unknown','retry_later','included','confirmed','original_included']);
  for(let i=0;i<ticks;i++) {
    const result=await runPublisher(storage,config,{fetch:guarded,scope:journal.envelope.scope_id,recovery:resume});
    outcomes.push(result.code);if(result.diagnostic)diagnostics.push({tick:i+1,diagnostic:result.diagnostic});
    if(!progress.has(result.code)||['confirmed','original_included'].includes(result.code))break;
  }
  const result=await inspectRecovery(storage),failure=outcomes.find(code=>!progress.has(code));
  return {...result,ok:!failure,mode:'recovery_resume',outcomes,diagnostics,broadcasts_sent:broadcasts,...(failure?{code:failure}:{})};
}

/** Exercise configured storage/provider with durable finite authority installed before signing.
 * The scope intentionally remains fenced after exit; cron/restart never resumes unlimited mode. */
export async function liveAcceptance(bindings,args=[],{fetch:fetcher=globalThis.fetch}={}) {
  if(args.some(arg=>/^--(inspect-recovery|install-recovery|resume-recovery)(=|$)/.test(arg)))return recoveryAcceptance(bindings,args,fetcher);
  const allowed=new Set(['--publish','--resume-scope','--check-sql','--name','--max-broadcasts','--max-fee-units','--max-new-locked-units','--ticks']);
  const options=new Map();
  for(const arg of args) {
    const [key,value,...extra]=arg.split('='),flag=['--publish','--check-sql'].includes(key);
    if(!allowed.has(key)||options.has(key)||extra.length||(flag?value!==undefined:!value))throw Error('invalid_scope');
    options.set(key,value??true);
  }
  const publish=options.has('--publish'),resume=options.get('--resume-scope'),authorized=publish||!!resume;
  if(resume&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(resume)||
    [...options.keys()].some(key=>!['--resume-scope','--ticks'].includes(key))))throw Error('invalid_scope');
  const number=(key,fallback)=>Number(options.get(key)??fallback);
  const ticks=number('--ticks',1),maximum=number('--max-broadcasts',0),maxFee=number('--max-fee-units',0),maxLocked=number('--max-new-locked-units',0);
  if(!Number.isSafeInteger(ticks)||ticks<1||ticks>10||
    publish&&(options.get('--name')!==APP_NAME||!Number.isSafeInteger(maximum)||maximum<1||maximum>4||
      !Number.isSafeInteger(maxFee)||maxFee<1||maxFee>100000||!Number.isSafeInteger(maxLocked)||maxLocked<0||maxLocked>NETWORK.nameMinimum+NETWORK.dust))throw Error('explicit_finite_budget_required');
  const config=publisherConfig(bindings);if(config.code)return {ok:false,code:config.code};
  const storage=new SupabaseStorage(bindings.SUPABASE_URL,bindings.SUPABASE_SERVICE_KEY,fetcher);
  const before=await publisherReadiness(storage,{appKey:config.appKey,markerKey:config.markerKey,baseUrl:config.baseUrl});let broadcasts=0;
  if(['schema_upgrade_required','identity_configuration_mismatch'].includes(before.code))return {ok:false,code:before.code,broadcasts:0};
  let scope=null;
  if(resume) {
    scope=(await storage.rpc('operational')).finite_scope;
    if(scope?.id!==resume||scope.name!==APP_NAME)return {ok:false,code:'finite_scope_mismatch',broadcasts:0};
  }
  const provider=createSpaceXpanseProvider({appKey:config.appKey,markerKey:config.markerKey,baseUrl:config.baseUrl,
    anchor:config.anchor??{height:0,hash:PROVIDER_DEFAULTS.genesisHash},fetch:fetcher});
  const {tip}=await provider.status();
  let sql='read_only',worker=null;
  if(options.has('--check-sql')) {
    const job=crypto.randomUUID(),lease=await storage.rpc('job',{owner:job});
    if(lease.code==='job_busy')sql='busy_unverified';
    else {
      try {
        if(lease.owner!==job)throw Error('sql_lease_failed');
        const overlaps=await Promise.all([storage.rpc('job',{owner:crypto.randomUUID()}),storage.rpc('job',{owner:crypto.randomUUID()})]);
        if(overlaps.some(row=>row.code!=='job_busy'))throw Error('sql_overlap_failed');
        sql='job_overlap_fenced';
      }finally {await storage.rpc('job_done',{job});}
    }
  }
  if(bindings.HD1_ACCEPTANCE_WORKER_URL) {
    const target=new URL(bindings.HD1_ACCEPTANCE_WORKER_URL);
    if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw Error('invalid_worker_target');
    const response=await fetcher(target.origin+'/api/leaderboard?limit=1',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('worker_unavailable');
    const text=await response.text();if(text.length>262144)throw Error('worker_response_too_large');
    for(const secret of [bindings.ROD_APP_WIF,bindings.SUPABASE_SERVICE_KEY,bindings.HD1_RATE_HMAC_KEY])if(text.includes(secret))throw Error('worker_secret_exposure');
    const result=JSON.parse(text);if(!Array.isArray(result.rows)||typeof result.available!=='boolean')throw Error('worker_shape');
    worker={http_status:response.status,available:result.available,stale:result.stale===true};
  }
  if(publish) {
    scope=await storage.rpc('finite_open',{id:crypto.randomUUID(),name:APP_NAME,max_transactions:maximum,
      max_fee_units:maxFee,max_new_locked_units:maxLocked});
    if(!scope?.id)return {ok:false,code:scope?.code??'finite_scope_unavailable',broadcasts:0};
  }
  const guarded=async(url,init={})=>{
    if((init.method??'GET')!=='GET') {
      if(!authorized||new URL(url).pathname!=='/broadcast')throw Error('broadcast_not_authorized');
      const raw=new URLSearchParams(init.body).get('raw'),tx=parseTransaction(raw);
      const state=await storage.read(),claim=state.claims.find(row=>row.raw===raw&&row.txid===tx.txid);
      const saved=(await storage.rpc('operational')).finite_scope,reservation=saved?.reservations[claim?.id];
      if(!claim||claim.attempts<1||saved?.id!==scope.id||reservation?.generation!==claim.generation)throw Error('scoped_outbox_required');
      broadcasts++;
    }
    return fetcher(url,init);
  };
  const outcomes=[],diagnostics=[];
  const allowedDiagnostics=new Set(['provider_timeout','provider_unavailable','broadcast_txid_mismatch',
    'broadcast_fee_rejected','broadcast_rejected','broadcast_failed']);
  // Read-only default does not call the scheduler, acquire a job or enter a signing barrier.
  const progress=new Set(['initial_sync','ready','broadcast_pending','broadcast_unknown','retry_later','included','confirmed']);
  if(authorized)for(let i=0;i<ticks;i++) {
    const result=await runPublisher(storage,config,{fetch:guarded,scope:scope.id}),outcome=result.code;
    outcomes.push(outcome);
    if(allowedDiagnostics.has(result.diagnostic))diagnostics.push({tick:i+1,code:outcome,diagnostic:result.diagnostic});
    if(!progress.has(outcome))break;
  }
  const after=await publisherReadiness(storage),saved=authorized?(await storage.rpc('operational')).finite_scope:null;
  const failure=outcomes.find(code=>!progress.has(code));
  return {ok:!failure,...(failure?{code:failure}:{}),mode:resume?'finite_resume':publish?'finite_publication':'read_only',scope:APP_NAME,trust:'provider_anchored',
    before,after,tip,sql,worker,outcomes,diagnostics,broadcasts,scope_id:saved?.id??null,
    reserved_transactions:saved?.transactions??0,broadcast_attempts:saved?.broadcasts??0,fee_units:saved?.fee_units??0,new_locked_units:saved?.new_locked_units??0,
    live_acceptance:'requires_observed_inclusion_reconstruction_and_hosted_concurrency'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const result=await liveAcceptance(process.env,process.argv.slice(2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
  catch {console.log(JSON.stringify({ok:false,code:'acceptance_failed_check_scope_bindings_and_budget'}));process.exitCode=1;}
}
