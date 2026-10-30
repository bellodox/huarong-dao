// Public non-funded keys and an in-memory REST provider, never a live chain.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { serialize,payScript,address,parseTransaction,hash256 } from '../leaderboard/chain.js';
import { bytesToHex,hexToBytes,base58check } from '../leaderboard/receipt.js';
import { headerHash,merkleRoot,PROVIDER_DEFAULTS } from '../leaderboard/provider.js';
import { publisherConfig } from '../leaderboard/publisher.js';
export const secret=Uint8Array.from([...Array(31).fill(0),2]);
export const bindings={ROD_APP_WIF:base58check(Uint8Array.from([78,...secret,1])),SUPABASE_URL:'https://db.test',
  SUPABASE_SERVICE_KEY:'nonfunded-service-fixture',HD1_RATE_HMAC_KEY:'nonfunded-publisher-rate-secret-0001',ROD_API_URL:'https://api.test'};
export const config=publisherConfig(bindings);
export const appKey=secp256k1.getPublicKey(secret),markerKey=hexToBytes(config.markerKey),BASE=100;
export const txidOf=raw=>bytesToHex(hash256(hexToBytes(raw)).reverse());
const filler=n=>bytesToHex(hash256(new TextEncoder().encode('public-fixture:'+n)));
export function payment(seed,key=appKey,amount=10000000) {
  return bytesToHex(serialize({version:1,inputs:[{txid:filler(seed),index:0}],outputs:[{amount,script:payScript(key)}],locktime:0}));
}
/** Realistic newest-first history and unspent rows include name ownership scripts. */
export function chainFixture() {
  const chain={blocks:[],txs:new Map(),mempool:[],calls:[],hooks:{},broadcasts:[]};
  chain.mine=(raws=[])=>{
    const height=BASE+chain.blocks.length,tx=[filler('block:'+height),...raws.map(txidOf)];
    const block={height,previousblockhash:chain.blocks.at(-1)?.hash??'ab'.repeat(32),merkleroot:merkleRoot(tx),version:536870912,
      time:345600+604800*2900+height*30,nonce:height,bits:'00000000',tx,txcount:tx.length};
    block.hash=headerHash(block);chain.blocks.push(block);
    for(const raw of raws)chain.txs.set(txidOf(raw),{raw,block});
    chain.mempool=chain.mempool.filter(raw=>!raws.includes(raw));return block;
  };
  chain.tip=()=>chain.blocks.at(-1);
  const scriptOf=addr=>[appKey,markerKey].map(key=>[address(key),bytesToHex(payScript(key))]).find(([a])=>a===addr)?.[1];
  const touching=script=>{
    const out=[];
    for(const [txid,{raw,block}] of chain.txs) {
      const tx=parseTransaction(raw,{funding:true});
      const spent=tx.inputs.some(input=>{const p=chain.txs.get(input.txid);return p&&bytesToHex(parseTransaction(p.raw,{funding:true}).outputs[input.index].script).endsWith(script);});
      if(spent||tx.outputs.some(o=>bytesToHex(o.script).endsWith(script)))out.push({txid,height:block.height});
    }
    for(const raw of chain.mempool)if(parseTransaction(raw).outputs.some(o=>bytesToHex(o.script).endsWith(script)))out.push({txid:txidOf(raw),height:1e12});
    return out.sort((a,b)=>b.height-a.height).map(row=>row.txid);
  };
  chain.route=(path,init={})=>{
    const url=new URL(path,'https://x'),parts=url.pathname.split('/').filter(Boolean),offset=Number(url.searchParams.get('offset')??0);
    if(parts[0]==='info')return {chain:'main',blocks:chain.tip().height,bestblockhash:chain.tip().hash};
    if(parts[0]==='hash')return PROVIDER_DEFAULTS.genesisHash;
    if(parts[0]==='range')return chain.blocks.filter(b=>b.height<=Number(parts[1])&&b.height>Number(parts[1])-offset).slice().reverse();
    if(parts[0]==='history'){const ids=touching(scriptOf(parts[1]));return {txcount:ids.length,tx:ids.slice(offset,offset+10)};}
    if(parts[0]==='transaction') {
      const entry=chain.txs.get(parts[1]);if(entry)return {hex:entry.raw,blockhash:entry.block.hash,height:entry.block.height};
      const raw=chain.mempool.find(raw=>txidOf(raw)===parts[1]);if(raw)return {hex:raw,height:-1};
      throw Object.assign(Error('not_found'),{providerCode:-5});
    }
    if(parts[0]==='unspent') {
      const script=scriptOf(parts[1]),spent=new Set();
      for(const {raw} of chain.txs.values())for(const input of parseTransaction(raw,{funding:true}).inputs)spent.add(input.txid+':'+input.index);
      const rows=[];
      for(const [txid,{raw,block}] of chain.txs)parseTransaction(raw,{funding:true}).outputs.forEach((output,index)=>{
        if(bytesToHex(output.script).endsWith(script)&&!spent.has(txid+':'+index))rows.push({txid,index,value:output.amount,height:block.height});
      });return rows;
    }
    if(parts[0]==='broadcast') {
      const raw=new URLSearchParams(init.body).get('raw');chain.broadcasts.push(raw);
      if(!chain.mempool.includes(raw))chain.mempool.push(raw);return txidOf(raw);
    }
    throw Error('fixture_route');
  };
  chain.fetch=async(url,init={})=>{
    const path=url.replace('https://api.test','');chain.calls.push(path);
    const override=await chain.hooks.any?.(path,init);if(override)return override;
    try {return Response.json({error:null,result:chain.route(path,init)});}
    catch(error){return Response.json({error:{code:error.providerCode??-1,message:error.message},result:null});}
  };
  chain.mine();chain.mine([payment(1)]);for(let i=0;i<12;i++)chain.mine();
  return chain;
}
export function connectDatabase(db) {
  const storage={rpc:async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value};
  storage.read=()=>storage.rpc('read');
  storage.publicRead=async(operation,payload={})=>(await db.query('select public.hd1_public($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
  return storage;
}
export async function databaseFixture(directory) {
  const db=new PGlite(directory);await db.exec('create role anon;create role authenticated;create role service_role;');await db.exec(migrations());
  const storage=connectDatabase(db);
  return {db,storage};
}
