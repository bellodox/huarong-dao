// Local PostgreSQL fixture adapter. No hosted credentials or chain connections.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { reconstruct } from '../leaderboard/reconcile.js';
let db;
async function reset() {
  if(db)await db.close();db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(readFileSync(new URL('../supabase/migrations/001_leaderboard.sql',import.meta.url),'utf8'));
  const history=JSON.parse(readFileSync(new URL('./fixtures/history.json',import.meta.url)));
  const snapshot=reconstruct(history);
  // Existing fixture rankings are readable; a distinct browser player may publish a registration.
  await db.query("select public.hd1_rpc('rebuild',$1::jsonb)",[JSON.stringify({revision:0,epoch:2900,head:null,snapshot:{...snapshot,stale:false}})]);
}
await reset();
const server=createServer(async(request,response)=>{
  try {
    let body='';for await(const chunk of request){body+=chunk;if(body.length>50000)throw Error('fixture_payload');}
    response.setHeader('Content-Type','application/json');
    if(request.url==='/reset') {await reset();response.end('{"ok":true}');return;}
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
