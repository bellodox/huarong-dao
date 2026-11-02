/** Versioned, seeded, deterministic gameplay witness for hd2 ranked sessions.
 * Seed binding establishes replay identity, not physical input provenance.
 * Event provenance cannot be authenticated by an untrusted web client.
 */
import {
  ALPHABET,CATALOG,PIECES,SHAPES,DIRECTIONS,positions,step,
  RANKED_PROFILE,RANKED_MOVE_MULTIPLIER,RANKED_MAX_MOVES
} from './profile.js';

export const SESSION_BODY_LIMIT=65536;
export const SESSION_INTERVAL=40;
export const SESSION_DOMAIN='huarong/ranked-session/v1';
const HEX=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
// This descriptor is a normative, versioned representation of replay-affecting rules.
// Changing it changes rule and layout digests; old witnesses retain their old digests.
const RULES=Object.freeze({
  protocol:RANKED_PROFILE,
  pieces:PIECES,shapes:SHAPES,directions:DIRECTIONS,
  goal:{piece:'CC',topLeftCell:13},
  move:'one legal cell per symbol, piece identity preserved',
  scoring:'floor((20*optimum^3+moves^2)/(2*moves^2))',
  rankedMoveMultiplier:RANKED_MOVE_MULTIPLIER
});

export class SessionFailure extends Error {
  constructor(code,status=422){super(code);this.code=code;this.status=status;}
}
export function isSessionId(id){return typeof id==='string'&&UUID.test(id);}
export function isSessionToken(value){return typeof value==='string'&&TOKEN.test(value);}
export function rankedLayout(layout){return typeof layout==='string'&&Object.hasOwn(CATALOG,layout)&&!CATALOG[layout].practice;}
export function randomToken(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function randomNonce(){
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function hashParts(...parts){
  const data=new TextEncoder().encode(JSON.stringify([SESSION_DOMAIN,...parts]));
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function tokenHash(token){return hashParts('token',token);}
export async function traceDigest(trace){return hashParts('trace',trace);}
export async function layoutSeed(layoutId){
  if(!rankedLayout(layoutId))throw new SessionFailure('invalid_layout');
  const layout=CATALOG[layoutId];
  const rulesDigest=await hashParts('rules',RULES);
  return {
    rulesDigest,
    layoutSeed:await hashParts('layout',layoutId,layout.board,layout.optimum,rulesDigest),
    board:layout.board,optimum:layout.optimum
  };
}
/** Bind the same canonical terms to fresh relay entropy and a ROD chain observation.
 * ROD block hashes are public, NOT wallet secrets or proof of genuine pointer input.
 */
export function validateRodAnchor(anchor){
  if(!anchor||typeof anchor!=='object'||!HEX.test(anchor.hash)||
    !Number.isSafeInteger(anchor.height)||anchor.height<0||anchor.height>999999999)
    throw new SessionFailure('rod_anchor_unavailable',503);
  return {height:anchor.height,hash:anchor.hash};
}
export async function sessionSeed(layoutId,sessionId,nonce,rodAnchor){
  if(!isSessionId(sessionId)||typeof nonce!=='string'||!HEX.test(nonce))throw new SessionFailure('invalid_nonce');
  const anchor=validateRodAnchor(rodAnchor);
  const origin=await layoutSeed(layoutId);
  return {...origin,rodAnchor:anchor,
    sessionSeed:await hashParts('session',origin.layoutSeed,sessionId,nonce,anchor.height,anchor.hash)};
}
export async function readSessionBody(request){
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new SessionFailure('malformed',400);
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>SESSION_BODY_LIMIT))throw new SessionFailure('payload_too_large',413);
  const reader=request.body?.getReader();if(!reader)throw new SessionFailure('malformed',400);
  const chunks=[];let size=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    size+=value.length;
    if(size>SESSION_BODY_LIMIT){await reader.cancel();throw new SessionFailure('payload_too_large',413);}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let off=0;
  for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length;}
  let body;
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new SessionFailure('malformed',400);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new SessionFailure('malformed',400);
  return body;
}

/** A trace entry is [tap=0/first drag=1/continued drag=2,ms,x0,y0,x1,y1].
 * Coordinates are normalized to 1000 units per board cell. These remain untrusted
 * client observations, cross-checked for consistency with each replayed move.
 */
export function verifySessionEvidence(layoutId,moves,traces,{complete=false}={}){
  if(!rankedLayout(layoutId))throw new SessionFailure('invalid_layout');
  if(typeof moves!=='string'||!/^[A-Za-z0-9_-]*$/.test(moves)||moves.length>RANKED_MAX_MOVES[layoutId])
    throw new SessionFailure('invalid_moves');
  if(!Array.isArray(traces)||traces.length!==moves.length)throw new SessionFailure('invalid_telemetry');
  let state=positions(CATALOG[layoutId].board),lastTime=-1,lastPiece=-1,lastKind=-1;
  for(let i=0;i<moves.length;i++){
    const symbol=moves[i],action=ALPHABET.indexOf(symbol);
    if(action<0||action>=40)throw new SessionFailure('invalid_moves');
    const entry=traces[i];
    if(!Array.isArray(entry)||entry.length!==6||entry.some(x=>!Number.isSafeInteger(x)))throw new SessionFailure('invalid_telemetry');
    const [kind,ms,x0,y0,x1,y1]=entry;
    if((kind!==0&&kind!==1&&kind!==2)||ms<lastTime||ms<0||ms>1800000||
      [x0,x1].some(x=>x< -700||x>4700)||[y0,y1].some(y=>y< -700||y>5700))throw new SessionFailure('invalid_telemetry');
    lastTime=ms;
    const piece=Math.floor(action/4),[dx,dy]=DIRECTIONS[action%4];
    const [width,height]=SHAPES[piece],px=state[piece]%4,py=Math.floor(state[piece]/4);
    if(kind===2){
      if(piece!==lastPiece||lastKind===0||lastKind===-1)throw new SessionFailure('telemetry_drag_sequence');
    }else if(x0<px*1000-250||x0>(px+width)*1000+250||y0<py*1000-250||y0>(py+height)*1000+250)
      throw new SessionFailure('telemetry_tile_mismatch');
    if(kind===0){
      // The current UI supports tap-to-move only if precisely one direction is legal.
      if(Math.abs(x1-x0)>250||Math.abs(y1-y0)>250)throw new SessionFailure('telemetry_tap_mismatch');
      let legal=0;
      for(let d=0;d<4;d++)try{step(state,ALPHABET[piece*4+d]);legal++;}catch{}
      if(legal!==1)throw new SessionFailure('telemetry_tap_mismatch');
    }else{
      const mx=x1-x0,my=y1-y0;
      if(dx!==0){
        if(Math.sign(mx)!==dx||Math.abs(mx)<320||Math.abs(mx)<=Math.abs(my))
          throw new SessionFailure('telemetry_drag_mismatch');
      }else if(Math.sign(my)!==dy||Math.abs(my)<320)
        throw new SessionFailure('telemetry_drag_mismatch');
    }
    try{state=step(state,symbol);}catch{throw new SessionFailure('invalid_moves');}
    lastPiece=piece;lastKind=kind;
  }
  if(complete&&(state[0]!==13||moves.length<CATALOG[layoutId].optimum))throw new SessionFailure('unsolved');
  return {moves:moves.length,solved:state[0]===13};
}

/** Session state is persisted in per-session SQL rows. Only the hashes and accepted
 * move prefix are retained; full untrusted pointer telemetry is never stored.
 */
export async function processSessionRequest(request,{storage,available,rateSecret,rodAnchor}={}){
  if(!available||!storage)return Response.json({code:'issuance_disabled'},{status:503});
  const pathname=new URL(request.url).pathname;
  const body=await readSessionBody(request);
  if(pathname==='/api/session/start'){
    if(!rankedLayout(body.layout)||Object.keys(body).some(k=>k!=='layout'))throw new SessionFailure('invalid_layout');
    const ip=request.headers.get('cf-connecting-ip');
    if(typeof rateSecret!=='string'||rateSecret.length<32||!ip||ip.length>64)throw new SessionFailure('issuance_disabled',503);
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(rateSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('hd2-session-ip-v1\0'+ip)));
    const bucket=Array.from(signed,b=>b.toString(16).padStart(2,'0')).join('');
    const id=crypto.randomUUID(),token=randomToken(),nonce=randomNonce();
    const seed=await sessionSeed(body.layout,id,nonce,rodAnchor);
    const firstTrace=await traceDigest([]);
    const head=await hashParts('chain-initial',seed.sessionSeed);
    const result=await storage.session('start',{
      id,layout:body.layout,bucket,token_hash:await tokenHash(token),nonce,
      rules_digest:seed.rulesDigest,layout_seed:seed.layoutSeed,session_seed:seed.sessionSeed,
      rod_block_hash:seed.rodAnchor.hash,rod_block_height:seed.rodAnchor.height,
      trace_digest:firstTrace,chain_head:head
    });
    if(result?.code!=='ok')throw new SessionFailure(
      ['rate_limited','anchor_changed'].includes(result?.code)?result.code:'session_unavailable',
      result?.code==='rate_limited'?429:result?.code==='anchor_changed'?409:503);
    return Response.json({id,token,nonce,interval:SESSION_INTERVAL,head,
      rulesDigest:seed.rulesDigest,layoutSeed:seed.layoutSeed,sessionSeed:seed.sessionSeed,
      rodAnchor:seed.rodAnchor,board:seed.board,optimum:seed.optimum},{headers:{'Cache-Control':'no-store'}});
  }
  if(!['/api/session/checkpoint','/api/session/finish'].includes(pathname))throw new SessionFailure('not_found',404);
  const final=pathname.endsWith('/finish');
  if(!isSessionId(body.id)||!isSessionToken(body.token)||!rankedLayout(body.layout)||
    typeof body.nonce!=='string'||!HEX.test(body.nonce)||typeof body.head!=='string'||!HEX.test(body.head)||
    !Number.isSafeInteger(body.seq)||body.seq<0||body.seq>40)throw new SessionFailure('malformed',400);
  if(!body.rodAnchor||typeof body.rodAnchor!=='object'||!HEX.test(body.rodAnchor.hash)||
    !Number.isSafeInteger(body.rodAnchor.height)||body.rodAnchor.height<0)
    throw new SessionFailure('malformed',400);
  const seed=await sessionSeed(body.layout,body.id,body.nonce,body.rodAnchor);
  if(body.rulesDigest!==seed.rulesDigest||body.layoutSeed!==seed.layoutSeed||body.sessionSeed!==seed.sessionSeed)
    throw new SessionFailure('seed_mismatch');
  verifySessionEvidence(body.layout,body.moves,body.trace,{complete:final});
  if(!final&&body.moves.length!==SESSION_INTERVAL*(body.seq+1))throw new SessionFailure('checkpoint_boundary');
  if(final&&body.seq<2)throw new SessionFailure('checkpoints_missing');
  const priorTrace=await traceDigest(body.trace.slice(0,SESSION_INTERVAL*body.seq));
  const currentTrace=await traceDigest(body.trace);
  const nextHead=await hashParts('chain-advance',body.head,seed.sessionSeed,
    body.seq,final?'finish':'checkpoint',body.moves,currentTrace);
  const inputDigest=final?await hashParts('input-final',seed.sessionSeed,body.moves,currentTrace):null;
  const next=randomToken(),proof=final?randomToken():null;
  const result=await storage.session('advance',{
    id:body.id,layout:body.layout,seq:body.seq,token_hash:await tokenHash(body.token),
    nonce:body.nonce,rules_digest:seed.rulesDigest,layout_seed:seed.layoutSeed,session_seed:seed.sessionSeed,
    rod_block_hash:seed.rodAnchor.hash,rod_block_height:seed.rodAnchor.height,
    moves:body.moves,prior_trace_digest:priorTrace,trace_digest:currentTrace,
    previous_head:body.head,next_head:nextHead,final,input_digest:inputDigest,
    next_hash:final?null:await tokenHash(next),proof_hash:final?await tokenHash(proof):null
  });
  if(result?.code!=='ok')throw new SessionFailure(result?.code||'session_conflict',409);
  const common={id:body.id,head:nextHead};
  return Response.json(final?
    {...common,proof,inputDigest,rulesDigest:seed.rulesDigest,layoutSeed:seed.layoutSeed,sessionSeed:seed.sessionSeed,nonce:body.nonce,rodAnchor:seed.rodAnchor}:
    {...common,seq:body.seq+1,token:next},{headers:{'Cache-Control':'no-store'}});
}
