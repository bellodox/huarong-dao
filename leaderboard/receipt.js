import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
export { bytesToHex, hexToBytes };
export const utf8 = text => new TextEncoder().encode(text);
export const MAX_VALUE_BYTES = 2048;
const KEYS = ['p','w','l','b','n','m','s','a'];
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Validate nickname scalars and forbid bytes that require canonical JSON escaping. */
export function validName(name) {
  return typeof name==='string' && name===name.normalize('NFC') && Array.from(name).length>=1 &&
    Array.from(name).length<=12 && utf8(name).length<=48 && !/["\\\x00-\x1f\x7f-\x9f<>\ud800-\udfff]/u.test(name);
}
/** Serialize only the fixed ordered fields, rejecting any non-profile value. */
export function canonical(claim,stage=Object.keys(claim).length) {
  if(![6,7,8].includes(stage) || Object.keys(claim).length!==stage ||
     Object.keys(claim).some((key,index)=>key!==KEYS[index])) throw Error('noncanonical');
  if(claim.p!=='hd1' || !Number.isSafeInteger(claim.w) || claim.w<0 || claim.w>9999999999 ||
     typeof claim.l!=='string' || !/^[A-Za-z0-9_]{1,16}$/.test(claim.l) ||
     typeof claim.b!=='string' || !/^[A-J.]{20}$/.test(claim.b) || !validName(claim.n) ||
     typeof claim.m!=='string' || !/^[A-Za-z0-9_-]+$/.test(claim.m)) throw Error('malformed');
  for(const key of ['s','a'].slice(0,stage-6)) if(!/^[A-Za-z0-9_-]{87}$/.test(claim[key])) throw Error('invalid_signature');
  return JSON.stringify(claim);
}
/** Parse bytes strictly: duplicate fields, alternate escapes and trailing data fail. */
export function parseCanonical(text,stage) {
  const claim=JSON.parse(text);
  if(canonical(claim,stage)!==text) throw Error('noncanonical');
  return claim;
}
/** Hash the domain, NUL and complete canonical object exactly once. */
export function digest(domain,text) { return sha256(utf8('huarong/hd1/'+domain+'\0'+text)); }
/** Encode recoverable signature with hd1's 31+recovery header. */
export function sign(domain,text,secret) {
  const signature=secp256k1.sign(digest(domain,text),secret,{prehash:false,lowS:true,format:'recovered'});
  signature[0]+=31;
  return btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
/** Recover and verify a canonical low-S compressed player or issuer identity. */
export function recover(domain,text,encoded) {
  if(!/^[A-Za-z0-9_-]{87}$/.test(encoded)) throw Error('invalid_signature');
  const signature=Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
  if(btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==encoded ||
     signature.length!==65 || signature[0]<31 || signature[0]>34) throw Error('invalid_signature');
  signature[0]-=31;
  const hash=digest(domain,text), parsed=secp256k1.Signature.fromBytes(signature,'recovered');
  if(parsed.hasHighS()) throw Error('invalid_signature');
  const key=secp256k1.recoverPublicKey(signature,hash,{prehash:false});
  if(!secp256k1.verify(signature.slice(1),hash,key,{prehash:false,lowS:true})) throw Error('invalid_signature');
  return bytesToHex(key);
}
/** Receipt identity is stable across app signing and all exact-raw retries. */
export function receiptId(playerClaim) { return bytesToHex(sha256(utf8(canonical(playerClaim,7)))); }
/** Enforce the actual final UTF-8 bound without replacing or truncating evidence. */
export function assertCapacity(playerClaim) {
  const bytes=utf8(canonical({...playerClaim,a:'A'.repeat(87)},8)).length;
  if(bytes>MAX_VALUE_BYTES) throw Error('evidence_too_large');
  return bytes;
}
/** Sign all evidence locally; no player transaction is created. */
export function signPlayer(unsigned,secret) {
  const text=canonical(unsigned,6), claim={...unsigned,s:sign('player',text,secret)};
  assertCapacity(claim);return claim;
}
/** Sign a complete self-contained application receipt. */
export function signApp(playerClaim,secret) {
  assertCapacity(playerClaim);
  return {...playerClaim,a:sign('app',canonical(playerClaim,7),secret)};
}
/** Decode Base58Check WIF, retaining the stored flag while normalizing identity elsewhere. */
export function decodeWif(wif,expectedVersion) {
  let value=0n;
  for(const character of wif) {const digit=BASE58.indexOf(character);if(digit<0)throw Error('invalid_wif');value=value*58n+BigInt(digit);}
  let hex=value.toString(16);if(hex.length%2)hex='0'+hex;
  const bytes=Uint8Array.from([...Array(wif.match(/^1*/)[0].length).fill(0),...hexToBytes(hex)]);
  const payload=bytes.slice(0,-4), checksum=sha256(sha256(payload)).slice(0,4);
  if(bytesToHex(checksum)!==bytesToHex(bytes.slice(-4)) || ![33,34].includes(payload.length) ||
     payload[0]!==expectedVersion || (payload.length===34 && payload[33]!==1)) throw Error('invalid_wif');
  const secret=payload.slice(1,33);secp256k1.getPublicKey(secret);return secret;
}
/** Base58Check encoding is shared by WIF and legacy address vectors. */
export function base58check(payload) {
  const bytes=Uint8Array.from([...payload,...sha256(sha256(payload)).slice(0,4)]);
  let value=BigInt('0x'+bytesToHex(bytes)), result='';
  while(value) {result=BASE58[Number(value%58n)]+result;value/=58n;}
  return '1'.repeat(bytes.findIndex(byte=>byte!==0))+result;
}
