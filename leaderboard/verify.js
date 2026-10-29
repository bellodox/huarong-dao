import { replay } from './profile.js';
import { parseCanonical, canonical, recover, receiptId, assertCapacity } from './receipt.js';
export const MAX_REQUEST_BYTES=8192;
/** The API exposes stable codes, not exception messages or bound credentials. */
export class ClaimError extends Error {
  constructor(code,status=400) {super(code);this.code=code;this.status=status;}
}
/** Verify all evidence independently of client scores and derive identity and points. */
export function verifyClaim(text,idempotencyKey) {
  if(new TextEncoder().encode(text).length>MAX_REQUEST_BYTES)throw new ClaimError('payload_too_large',413);
  let claim;
  try {claim=parseCanonical(text,7);assertCapacity(claim);} catch(error) {
    throw new ClaimError(error.message==='evidence_too_large'?'evidence_too_large':'malformed',error.message==='evidence_too_large'?422:400);
  }
  let player;
  try {const {s,...unsigned}=claim;player=recover('player',canonical(unsigned,6),s);} catch {throw new ClaimError('invalid_signature',401);}
  const id=receiptId(claim);
  if(id!==idempotencyKey)throw new ClaimError('idempotency_conflict',409);
  let derived;
  try {derived=replay(claim);} catch(error) {throw new ClaimError(error.message==='practice_layout'?'practice_layout':'invalid_replay',422);}
  return {id,claim,text,player,moves:derived.moves,points:derived.points};
}
/** Read a bounded stream before parsing or expensive cryptography. */
export async function readClaim(request) {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new ClaimError('malformed',400);
  const length=request.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>MAX_REQUEST_BYTES))throw new ClaimError('payload_too_large',413);
  const reader=request.body?.getReader();if(!reader)throw new ClaimError('malformed');
  const chunks=[];let size=0;
  for(;;) {
    const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>MAX_REQUEST_BYTES){await reader.cancel();throw new ClaimError('payload_too_large',413);}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ClaimError('malformed');}
}
/** Cross-origin writes and non-browser foreign origins are rejected, not granted CORS. */
export function checkOrigin(request) {
  const origin=request.headers.get('origin');
  if(origin!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site')throw new ClaimError('origin_forbidden',403);
}
