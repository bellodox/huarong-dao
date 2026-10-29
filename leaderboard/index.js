import { publicStatus } from './storage.js';
import { CATALOG } from './profile.js';

/** Validate bounded public pagination before calling the lock-free read function. */
export async function publicLeaderboard(storage,query) {
  if(query.toString().length>2048)throw Error('invalid_query');
  const scope=query.get('scope')||'lifetime',weekText=query.get('week'),limitText=query.get('limit')||'20';
  const layout=query.get('layout')||null,player=query.get('player')||null;
  if(!['lifetime','week'].includes(scope)||!/^\d{1,3}$/.test(limitText)||Number(limitText)<1||Number(limitText)>100||
    (scope==='week'&&!/^\d{1,10}$/.test(weekText||''))||(layout&&(!CATALOG[layout]||CATALOG[layout].practice))||
    (player&&!/^(02|03)[a-f0-9]{64}$/.test(player)))throw Error('invalid_query');
  const week=scope==='week'?Number(weekText):null,limit=Number(limitText);
  let cursor=null,offset=0;
  if(query.has('cursor')) {
    try {cursor=JSON.parse(atob(query.get('cursor')));offset=cursor.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw Error();}
    catch{throw Error('stale_cursor');}
  }
  const result=await storage.publicRead('leaderboard',{scope,week,layout,player,limit,offset});
  const fingerprint=[result.snapshot_revision,scope,week,layout,player].join(':');
  if(cursor&&cursor.fingerprint!==fingerprint)throw Error('stale_cursor');
  const {has_more,...page}=result;
  return {...page,scope,week,cursor:has_more&&offset+limit<=10000?btoa(JSON.stringify({fingerprint,offset:offset+limit})):null,
    assurance:'replayed',rewards_enabled:false};
}
/** Derive rankings from already authenticated, replayed confirmed receipts only. */
export function rank(receipts,{scope='lifetime',week=null,layout=null}={}) {
  const best=new Map();
  for(const receipt of receipts) {
    if(scope==='week'&&receipt.epoch!==week)continue;
    if(layout&&receipt.layout!==layout)continue;
    const id=receipt.player+':'+receipt.layout, old=best.get(id);
    if(!old||receipt.moves<old.moves)best.set(id,receipt);
  }
  const players=new Map();
  for(const receipt of best.values()) {
    const row=players.get(receipt.player)||{player:receipt.player,nickname:receipt.nickname,points:0,completed:0,bests:{}};
    row.points+=receipt.points;row.completed++;row.bests[receipt.layout]={moves:receipt.moves,points:receipt.points,receipt_id:receipt.id};
    players.set(row.player,row);
  }
  return [...players.values()].sort((a,b)=>layout?
    a.bests[layout].moves-b.bests[layout].moves||(a.player<b.player?-1:a.player>b.player?1:0):
    b.points-a.points||b.completed-a.completed||(a.player<b.player?-1:a.player>b.player?1:0));
}
/** Cursor is bound to snapshot revision and query, never an offset into mutable rankings. */
export function leaderboardPage(state,query) {
  const scope=query.get('scope')||'lifetime',weekText=query.get('week'),limitText=query.get('limit')||'20';
  if(!['lifetime','week'].includes(scope)||!/^\d+$/.test(limitText)||Number(limitText)<1||Number(limitText)>100||
    (scope==='week'&&(!/^\d{1,10}$/.test(weekText||''))))throw Error('invalid_query');
  const week=scope==='week'?Number(weekText):null,layout=query.get('layout'),player=query.get('player');
  if(player&&!/^(02|03)[a-f0-9]{64}$/.test(player))throw Error('invalid_query');
  const revision=state.coordinator.revision, fingerprint=[revision,scope,week,layout,player].join(':');
  let offset=0;
  if(query.has('cursor')) {
    try {const cursor=JSON.parse(atob(query.get('cursor')));if(cursor.fingerprint!==fingerprint||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}
    catch{throw Error('stale_cursor');}
  }
  const snapshot=state.coordinator.snapshot, rows=rank(snapshot.receipts||[],{scope,week,layout}).filter(row=>!player||row.player===player);
  const limit=Number(limitText),next=offset+limit<rows.length?btoa(JSON.stringify({fingerprint,offset:offset+limit})):null;
  return {rows:rows.slice(offset,offset+limit),cursor:next,scope,week,epoch:state.coordinator.epoch,snapshot_revision:revision,
    confirmed_height:snapshot.height??null,confirmed_hash:snapshot.hash??null,stale:snapshot.stale!==false,
    pending:state.claims.filter(claim=>!['confirmed','not_improved','cancelled','rejected','epoch_changed'].includes(claim.state)).map(publicStatus),
    assurance:'replayed',rewards_enabled:false};
}
