import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex,hexToBytes,utf8,base58check,canonical } from './receipt.js';
export const APP_NAME='g/huarong-lb';
export const NETWORK=Object.freeze({address:60,wif:78,nameMinimum:1000000,dust:600});
// Experimental base-unit caps, not a claim about live relay policy. No adapter override.
export const FEE_POLICY=Object.freeze({maximum:100000,perByte:100});
export const concat=(...parts)=>Uint8Array.from(parts.flatMap(part=>Array.from(part)));
export const hash256=bytes=>sha256(sha256(bytes));
export const hash160=bytes=>ripemd160(sha256(bytes));
/** Encode an unsigned integer in exact little-endian base units. */
export function le(value,size) {
  value=BigInt(value);if(value<0n || value>=1n<<BigInt(size*8))throw Error('integer_range');
  const bytes=new Uint8Array(size);for(let i=0;i<size;i++){bytes[i]=Number(value&255n);value>>=8n;}return bytes;
}
/** Canonical Bitcoin compact-size integer. */
export function varint(value) {
  if(!Number.isSafeInteger(value)||value<0)throw Error('integer_range');
  return value<253?le(value,1):value<=65535?concat([253],le(value,2)):concat([254],le(value,4));
}
export const variable=bytes=>concat(varint(bytes.length),bytes);
/** Minimal script push, including full PUSHDATA2 name values. */
export function push(bytes) {
  return concat(bytes.length<76?[bytes.length]:bytes.length<=255?[76,bytes.length]:concat([77],le(bytes.length,2)),bytes);
}
export const payScript=key=>concat([0x76,0xa9,20],hash160(key),[0x88,0xac]);
export const address=(key,version=NETWORK.address)=>base58check(concat([version],hash160(key)));
/** Name value is the complete canonical receipt, never a digest or snapshot. */
export function nameScript(operation,receipt,key) {
  const value=utf8(canonical(receipt,8));if(value.length>2048)throw Error('evidence_too_large');
  if(!['register','update'].includes(operation))throw Error('invalid_operation');
  return concat([operation==='register'?0x51:0x52],push(utf8(APP_NAME)),push(value),[0x6d,0x75],payScript(key));
}
/** Serialize non-witness legacy transaction with integer amounts only. */
export function serialize(tx,scripts=tx.inputs.map(input=>input.script||new Uint8Array())) {
  return concat(le(tx.version??2,4),varint(tx.inputs.length),...tx.inputs.map((input,index)=>concat(
    hexToBytes(input.txid).slice().reverse(),le(input.index,4),variable(scripts[index]),le(0xffffffff,4))),
    varint(tx.outputs.length),...tx.outputs.map(output=>concat(le(output.amount,8),variable(output.script))),le(tx.locktime??0,4));
}
/** Legacy SIGHASH_ALL commits to the complete previous script, with no upstream parser. */
export function sighash(tx,index,previousScript) {
  const scripts=tx.inputs.map((_,i)=>i===index?previousScript:new Uint8Array());
  return hash256(concat(serialize(tx,scripts),le(1,4)));
}
/** Sign every reserved app-owned input once after the durable barrier. */
export function signTransaction(tx,secret) {
  const key=secp256k1.getPublicKey(secret);
  tx.inputs.forEach((input,index)=>{
    const signature=secp256k1.sign(sighash(tx,index,input.previousScript),secret,{prehash:false,lowS:true,format:'der'});
    input.script=concat(push(concat(signature,[1])),push(key));
  });
  const bytes=serialize(tx);if(bytes.length*4>=40000)throw Error('transaction_weight');
  return {raw:bytesToHex(bytes),txid:bytesToHex(hash256(bytes).reverse()),weight:bytes.length*4};
}
/** Build only a reserved register/update, with a separate dedicated marker output. */
export function buildTransaction(prepared,receipt,appKey,markerKey) {
  const {inputs,fee,markerAmount,nameAmount,operation}=prepared;
  if(!inputs?.length || inputs.length>10 || !Number.isSafeInteger(fee) || fee<=0 ||
     !Number.isSafeInteger(markerAmount) || markerAmount<NETWORK.dust || !Number.isSafeInteger(nameAmount) || nameAmount<NETWORK.nameMinimum)throw Error('funds_unavailable');
  if(fee>FEE_POLICY.maximum)throw Error('excessive_fee');
  if(bytesToHex(appKey)===bytesToHex(markerKey))throw Error('marker_not_dedicated');
  let total=0;
  const mapped=inputs.map(input=>{
    if(!/^[a-f0-9]{64}$/.test(input.txid)||!Number.isSafeInteger(input.index)||input.index<0||!Number.isSafeInteger(input.amount)||input.amount<0)throw Error('invalid_input');
    const previous=parseTransaction(input.previousRaw),output=previous.outputs[input.index];
    if(previous.txid!==input.txid||!output||output.amount!==input.amount||bytesToHex(output.script)!==input.script)throw Error('unauthenticated_prevout');
    const previousScript=output.script;
    if(bytesToHex(previousScript.slice(-25))!==bytesToHex(payScript(appKey)))throw Error('input_not_owned');
    if(previousScript.length!==25&&!parseName(previousScript))throw Error('input_not_owned');
    total+=output.amount;if(!Number.isSafeInteger(total))throw Error('integer_range');
    return {...input,amount:output.amount,previousScript};
  });
  if(new Set(inputs.map(input=>input.txid+':'+input.index)).size!==inputs.length)throw Error('duplicate_input');
  if(!['register','update'].includes(operation))throw Error('invalid_operation');
  const names=mapped.filter(input=>[0x51,0x52].includes(input.previousScript[0]));
  if((operation==='register'&&names.length!==0)||(operation==='update'&&names.length!==1))throw Error('invalid_name_inputs');
  if(names.some(input=>parseName(input.previousScript).name!==APP_NAME))throw Error('invalid_name_inputs');
  const change=total-fee-markerAmount-nameAmount;
  if(!Number.isSafeInteger(change)||change<0||(change>0&&change<NETWORK.dust))throw Error('funds_unavailable');
  const outputs=[{amount:nameAmount,script:nameScript(operation,receipt,appKey)},{amount:markerAmount,script:payScript(markerKey)}];
  if(change)outputs.push({amount:change,script:payScript(appKey)});
  const transaction={version:2,inputs:mapped,outputs,locktime:0};
  // Empty unlocking scripts give a conservative lower byte bound before any signing.
  // Actual signed bytes can only be larger, so their fee rate cannot exceed this check.
  const minimumBytes=serialize(transaction,mapped.map(()=>new Uint8Array())).length;
  if(fee>minimumBytes*FEE_POLICY.perByte)throw Error('excessive_fee_rate');
  return transaction;
}
/** Bounded canonical raw reader, rejecting truncated/nonminimal compact sizes. */
export function rawReader(bytes) {
  let offset=0;
  const take=count=>{if(!Number.isSafeInteger(count)||count<0||offset+count>bytes.length)throw Error('truncated_raw');const result=bytes.slice(offset,offset+count);offset+=count;return result;};
  const number=size=>{const chunk=take(size);let value=0n;for(let i=size-1;i>=0;i--)value=value*256n+BigInt(chunk[i]);if(value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('integer_range');return Number(value);};
  const compact=()=>{const prefix=number(1);if(prefix<253)return prefix;const value=number(prefix===253?2:prefix===254?4:8);if(value<(prefix===253?253:prefix===254?65536:4294967296))throw Error('nonminimal_size');return value;};
  return {take,number,compact,remaining:()=>bytes.length-offset};
}
/** Decode exact legacy transaction bytes; metadata cannot substitute for raw scripts. */
export function parseTransaction(raw) {
  if(typeof raw!=='string'||!/^([a-f0-9]{2})+$/.test(raw)||raw.length>=20000)throw Error('invalid_raw');
  const bytes=hexToBytes(raw), reader=rawReader(bytes), version=reader.number(4);
  if(version!==2)throw Error('unsupported_transaction');
  const inputCount=reader.compact();if(inputCount<1||inputCount>100)throw Error('invalid_inputs');
  const inputs=Array.from({length:inputCount},()=>{
    const txid=bytesToHex(reader.take(32).reverse()),index=reader.number(4),script=reader.take(reader.compact());
    if(reader.number(4)!==0xffffffff)throw Error('unsupported_sequence');return {txid,index,script};
  });
  const outputCount=reader.compact();if(outputCount<1||outputCount>100)throw Error('invalid_outputs');
  const outputs=Array.from({length:outputCount},()=>({amount:reader.number(8),script:reader.take(reader.compact())}));
  const locktime=reader.number(4);if(reader.remaining())throw Error('trailing_raw');
  const tx={version,inputs,outputs,locktime};
  if(bytesToHex(serialize(tx))!==raw)throw Error('noncanonical_transaction');
  return {...tx,txid:bytesToHex(hash256(bytes).reverse()),weight:bytes.length*4};
}
/** Read minimal pushdata without the upstream long-value script parser. */
export function readPush(reader) {
  const opcode=reader.number(1);
  if(opcode>77)throw Error('invalid_push');
  const length=opcode<76?opcode:reader.number(opcode===76?1:2);
  if((opcode===76&&length<76)||(opcode===77&&length<=255))throw Error('nonminimal_push');
  return reader.take(length);
}
/** Parse original name op and its trailing ownership script, not decoded API metadata. */
export function parseName(script) {
  if(![0x51,0x52].includes(script[0]))return null;
  const reader=rawReader(script),operation=reader.number(1)===0x51?'register':'update';
  const name=new TextDecoder('utf-8',{fatal:true}).decode(readPush(reader));
  const value=readPush(reader);if(value.length>2048)throw Error('evidence_too_large');
  if(reader.number(1)!==0x6d||reader.number(1)!==0x75)throw Error('invalid_name_script');
  const payment=reader.take(reader.remaining());
  if(payment.length!==25)throw Error('invalid_name_owner');
  return {operation,name,value:new TextDecoder('utf-8',{fatal:true}).decode(value),payment};
}
/** Authenticate transaction ownership against each full previous raw output script. */
export function verifyInput(tx,index,previousScript,key) {
  if(bytesToHex(previousScript.slice(-25))!==bytesToHex(payScript(key)))throw Error('input_not_owned');
  const reader=rawReader(tx.inputs[index].script),signature=readPush(reader),publicKey=readPush(reader);
  if(reader.remaining()||signature.at(-1)!==1||bytesToHex(publicKey)!==bytesToHex(key)||
    !secp256k1.verify(signature.slice(0,-1),sighash(tx,index,previousScript),key,{format:'der',prehash:false,lowS:true}))throw Error('invalid_transaction_signature');
  return true;
}
