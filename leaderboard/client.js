import { secp256k1 } from '@noble/curves/secp256k1.js';
import { canonical,signPlayer,receiptId,base58check,decodeWif } from './receipt.js';
import { replay } from './profile.js';
const IDENTITY_KEY='huarong_rod_identity_v1';
/** Existing WIF is never overwritten or normalized in storage. No wallet before opt-in. */
function playerSecret(storage) {
  const existing=storage.getItem(IDENTITY_KEY);
  if(existing) {
    const identity=JSON.parse(existing);
    if(typeof identity?.wif!=='string')throw Error('identity_invalid');
    return decodeWif(identity.wif,78);
  }
  const secret=secp256k1.keygen().secretKey;
  const encoded=JSON.stringify({wif:base58check(Uint8Array.from([78,...secret,1]))});
  storage.setItem(IDENTITY_KEY,encoded);
  if(storage.getItem(IDENTITY_KEY)!==encoded)throw Error('identity_save_failed');
  return secret;
}
/** Sign complete valid evidence locally; recheck consent after async module loading. */
export function createSignedClaim(evidence,name,epoch,{storage=localStorage,consented=()=>false}={}) {
  if(!consented()||evidence.assisted)throw Error('consent_required');
  const unsigned={p:'hd1',w:epoch,l:evidence.l,b:evidence.b,n:name,m:evidence.m};
  replay(unsigned);
  const claim=signPlayer(unsigned,playerSecret(storage));
  if(!consented())throw Error('consent_required');
  return {id:receiptId(claim),bytes:canonical(claim,7)};
}
/** Export is local and explicit, never sent to Worker or chain APIs. */
export function exportIdentity(storage=localStorage) {
  const identity=storage.getItem(IDENTITY_KEY);if(!identity)throw Error('identity_missing');return identity;
}
