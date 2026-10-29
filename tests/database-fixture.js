// Local PostgreSQL fixture adapter. No hosted credentials or chain connections.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';
import { reconstruct,reconcile } from '../leaderboard/reconcile.js';
let db,canonicalHistory;
const rpc=async(operation,payload={})=>(await db.query('select public.hd1_rpc($1,$2::jsonb) as value',[operation,JSON.stringify(payload)])).rows[0].value;
async function reset(canonicalHead=false) {
  if(db)await db.close();db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(migrations());
  const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
  canonicalHistory={...history,headers:history.headers.slice(0,3)};
  const snapshot=reconstruct(canonicalHead?canonicalHistory:history);
  // Existing fixture rankings are readable; a distinct browser player may publish a registration.
  await db.query("select public.hd1_rpc('rebuild',$1::jsonb)",[JSON.stringify({revision:(await db.query('select revision from public.hd1_coordinator')).rows[0].revision,epoch:2900,head:canonicalHead?snapshot.head:null,snapshot:{...snapshot,stale:false}})]);
}
await reset();
const server=createServer(async(request,response)=>{
  try {
    let body='';for await(const chunk of request){body+=chunk;if(body.length>50000)throw Error('fixture_payload');}
    response.setHeader('Content-Type','application/json');
    if(request.url==='/reset') {await reset();response.end('{"ok":true}');return;}
    if(request.url==='/prepare') {
      const {coordinator}=await rpc('read');
      const previousRaw=coordinator.head?coordinator.snapshot.lineage?.find(row=>row.head===coordinator.head)?.raw:null;
      response.end(JSON.stringify({head:coordinator.head,epoch:coordinator.epoch,previousRaw}));return;
    }
    if(request.url==='/d6') {
      const {action,id}=JSON.parse(body);
      if(action==='start')await reset(true);
      else if(action==='include') {
        const {claims}=await rpc('read'),claim=claims.find(row=>row.id===id);
        if(!claim?.raw)throw Error('missing_raw');
        const height=canonicalHistory.headers.length;
        const headers=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url))).headers;
        canonicalHistory={...canonicalHistory,headers:headers.slice(0,height+1),transactions:[...canonicalHistory.transactions,{raw:claim.raw,height,index:0,blockHash:headers[height].hash}]};
        await reconcile({rpc},{history:async()=>canonicalHistory});
      }else throw Error('invalid_fixture_action');
      response.end(JSON.stringify(await rpc('read')));return;
    }
    if(request.url==='/broadcast') {
      const {raw}=JSON.parse(body);
      const stored=(await db.query('select raw from public.hd1_claims where raw=$1',[raw])).rows;
      if(stored.length!==1)throw Error('broadcast_before_persistence');
      response.end('{"fixture":"persisted_before_transport"}');return;
    }
    const {operation,payload}=JSON.parse(body);
    const query=request.url==='/public'?'select public.hd1_public($1,$2::jsonb) as result':'select public.hd1_rpc($1,$2::jsonb) as result';
    const result=(await db.query(query,[operation,JSON.stringify(payload)])).rows[0].result;
    response.end(JSON.stringify(result));
  }catch {response.statusCode=503;response.end('{"code":"fixture_unavailable"}');}
});
server.listen(8790,'127.0.0.1',()=>console.log('fixture PostgreSQL ready on loopback 8790'));
