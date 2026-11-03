import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrations } from './schema.js';

const ids=char=>char.repeat(64);
const player=char=>'02'+char.repeat(64);
const layout='rear_guard';

// Requires PGlite dev dependency. Runs against all migrations, including 012.
test('PostgreSQL: receipt-derived moves lead; accepted duration sorts ties before pagination',async()=>{
  const db=new PGlite();
  try{
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(migrations(null));
    await db.query("update public.hd1_coordinator set paused=false,epoch=10,snapshot=jsonb_build_object('stale',false,'height',1000,'hash',repeat('a',64)) where singleton");
    for(const [label,nickname,duration,txHeight] of [
      ['a','Slow',500,50],['b','Fast',350,60],['c','Untimed',null,70],['d','More moves',100,80]
    ]){
      const n=label==='d'?86:82,points=n===82?820:745;
      await db.query(`insert into public.hd1_receipts(id,txid,player,nickname,layout,epoch,moves,points,
        height,transaction_index,output_index,receipt) values ($1,$2,$3,$4,$5,10,$6,$7,$8,0,0,'PRIVATE RECEIPT')`,
        [ids(label),ids(label),player(label),nickname,layout,n,points,txHeight]);
      if(duration!==null)await db.query(`insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,
        moves,points,state,evaluation_revision,duration_ds) values ($1,'PRIVATE',$2,$3,$4,10,$5,$6,'confirmed',0,$7)`,
        [ids(label),player(label),nickname,layout,n,points,duration]);
    }
    const read=async payload=>(await db.query("select public.hd1_public('leaderboard',$1::jsonb) as value",
      [JSON.stringify(payload)])).rows[0].value;
    const full=await read({scope:'lifetime',layout,limit:20,offset:0});
    assert.deepEqual(full.rows.map(row=>row.nickname),['Fast','Slow','Untimed','More moves']);
    assert.deepEqual(full.rows.map(row=>row.bests[layout].duration_ds),[350,500,null,100]);
    assert.equal(full.has_more,false);
    const first=await read({scope:'week',week:10,layout,limit:2,offset:0});
    assert.deepEqual(first.rows.map(row=>row.nickname),['Fast','Slow']);
    assert.equal(first.has_more,true);
    const second=await read({scope:'week',week:10,layout,limit:2,offset:2});
    assert.deepEqual(second.rows.map(row=>row.nickname),['Untimed','More moves']);
    assert.equal(second.has_more,false);
    const overall=await read({scope:'lifetime',limit:20,offset:0});
    assert.deepEqual(overall.rows.map(row=>row.nickname),['Slow','Fast','Untimed','More moves'],
      'overall score ties keep the original deterministic player order');

    // Admission's existing final update of a sealed session must durably copy
    // the time to the claim, and must not modify the move count or points.
    await db.query(`insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
      values ($1,'PRIVATE',$2,'Trigger', $3,10,82,820,'queued',0)`,[ids('e'),player('e'),layout]);
    const uuid='19ad2c82-a710-4842-8c36-16b88b4b693a';
    await db.query(`insert into public.hd_ranked_sessions(id,layout,state,moves,nonce,rules_digest,layout_seed,
      session_seed,rod_block_hash,rod_block_height,trace_digest,chain_head,token_hash,expires_at,duration_ds)
      values ($1,$2,'sealed',$3,$4,$4,$4,$4,$4,1000,$4,$4,$4,now()+interval '1 day',417)`,
      [uuid,layout,'A'.repeat(82),ids('f')]);
    await db.query(`update public.hd_ranked_sessions set state='admitted',receipt_id=$1 where id=$2::uuid`,
      [ids('e'),uuid]);
    const claim=(await db.query(`select duration_ds,moves,points from public.hd1_claims where id=$1`,[ids('e')])).rows[0];
    assert.equal(claim.duration_ds,417);assert.equal(claim.moves,82);assert.equal(claim.points,820);

    await db.exec('set role service_role;begin read only;');
    await db.query("select public.hd1_public('leaderboard', '{\"layout\":\"rear_guard\"}')");
    await db.exec('rollback;reset role;');
    await db.exec('set role anon;');
    await assert.rejects(db.query("select public.hd1_public('leaderboard','{}')"),/permission denied/);
  }finally{await db.close();}
});
