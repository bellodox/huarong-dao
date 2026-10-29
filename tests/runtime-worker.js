// Loopback-only fixture entry. Never referenced by production Wrangler configuration.
import worker,{handleApi} from '../worker.js';
import { canonical,signPlayer,signApp,recover,receiptId,hexToBytes,bytesToHex,parseTransaction } from '../relay.js';
import { relayProbe } from './relay-probe.js';
import transactions from './fixtures/transactions.json';
import vectors from './fixtures/receipt.json';
const secret=Uint8Array.from([...Array(31).fill(0),2]);
const markerKey=hexToBytes(transactions.markerKey);
const storage={rpc:async(operation,payload={})=>{
  const response=await fetch('http://127.0.0.1:8790/rpc',{method:'POST',body:JSON.stringify({operation,payload})});
  if(!response.ok)throw Error('fixture_database_unavailable');return response.json();
}};
storage.read=()=>storage.rpc('read');
storage.publicRead=async(operation,payload={})=>{
  const response=await fetch('http://127.0.0.1:8790/public',{method:'POST',body:JSON.stringify({operation,payload})});
  if(!response.ok)throw Error('fixture_database_unavailable');return response.json();
};
const chain={
  prepare:async()=>{
    const response=await fetch('http://127.0.0.1:8790/prepare');
    if(!response.ok)throw Error('fixture_prepare_unavailable');
    const {head,epoch,previousRaw}=await response.json();
    if(head===null)return {epoch,head,prepared:transactions.prepared};
    const previous=parseTransaction(previousRaw);
    return {epoch,head,prepared:{operation:'update',fee:40000,markerAmount:10000,nameAmount:previous.outputs[0].amount-60000,
      inputs:[{txid:previous.txid,index:0,amount:previous.outputs[0].amount,script:bytesToHex(previous.outputs[0].script),previousRaw}]}};
  },
  validate:async()=>true,lookup:async()=>null,
  broadcast:async raw=>{
    await fetch('http://127.0.0.1:8790/broadcast',{method:'POST',body:JSON.stringify({raw})});
    throw Error('fixture_ambiguous_timeout');
  }
};
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/__fixture/portable'&&request.method==='POST') {
      return Response.json((await request.json()).map(relayProbe));
    }
    if(path==='/__fixture/vector') {
      const {s,...unsigned}=vectors.playerClaim;
      const player=signPlayer(unsigned,Uint8Array.from([...Array(31).fill(0),1])),receipt=signApp(player,secret);
      return Response.json({id:receiptId(player),player:recover('player',canonical(unsigned,6),player.s),app:recover('app',canonical(player,7),receipt.a),matches:canonical(receipt,8)===canonical(vectors.receipt,8)});
    }
    if(path==='/__fixture/state')return Response.json(await storage.read());
    if(path==='/__fixture/d6'&&request.method==='POST')return fetch('http://127.0.0.1:8790/d6',{method:'POST',body:await request.text()});
    if(path==='/__fixture/reset') {
      return fetch('http://127.0.0.1:8790/reset',{method:'POST'});
    }
    if(path.startsWith('/api/')) {
      // Known public fixture key and documentation-only IP: never production credentials.
      const local=new Request(request);local.headers.set('cf-connecting-ip','192.0.2.1');
      return handleApi(local,{storage,available:true,rateSecret:'public-nonfunded-fixture-hmac-key-01',issuer:{chain,secret,markerKey}});
    }
    return worker.fetch(request,env);
  }
};
