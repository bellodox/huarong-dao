// Frozen hd1 rules. Piece identity is preserved; BFS canonicalization is not replay.
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const PIECES = ['CC','ZY','ZF','MC','HZ','GY','S1','S2','S3','S4'];
export const SHAPES = [[2,2],[1,2],[1,2],[1,2],[1,2],[2,1],[1,1],[1,1],[1,1],[1,1]];
export const DIRECTIONS = [[0,-1],[1,0],[0,1],[-1,0]];
export const CATALOG = Object.freeze(Object.fromEntries([
  ['training',24,'DCBJDCB.EAA.EAAHGIFF',true],
  ['first_steps',32,'DBHJDB..ECAAECAAGIFF',true],
  ['next_steps',50,'IHAADBAADBFFEC.GEC.J',true],
  ['wings',116,'BAACBAACDFFEDIJEG..H'],
  ['heng_dao_li_ma',118,'BAACBAACDFFED..EGHIJ'],
  ['rear_guard',82,'BAACBAACDGHEDIJE.FF.'],
  ['small_obstacle',100,'BAACBAACGFFHDIJED..E'],
  ['ambush',110,'BAACBAACGFFHIDEJ.DE.'],
  ['fayaa_sideBySide',85,'CAABCAABGHIJDFFED..E'],
  ['fayaa_threeRoads',92,'GAAHCAABCFFBDIJED..E'],
  ['fayaa_peach',100,'GAAHCAABCDEBIDEJ.FF.'],
  ['fayaa_rain2',119,'CAA.CAAGFFBDE.BDEHIJ'],
  ['fayaa_cannotStop',126,'.AACGAACBFFDBE.DHEIJ'],
  ['fayaa_highRisk',126,'AAC.AAC.GBFFDBHEDIJE']
].map(([id,optimum,board,practice=false]) => [id,Object.freeze({optimum,board,practice})])));

export const RANKED_PROFILE = 'hd2';
export const RANKED_MOVE_MULTIPLIER = 10;
export const RANKED_MAX_MOVES = Object.freeze(Object.fromEntries(Object.entries(CATALOG)
  .filter(([,layout])=>!layout.practice).map(([id,layout])=>[id,RANKED_MOVE_MULTIPLIER*layout.optimum])));
/** Resolve only known immutable profile versions. */
export function assertProfile(profile) {
  if(profile!=='hd1' && profile!==RANKED_PROFILE)throw Error('unknown_profile');
  return profile;
}
/** Legacy replay has no ranked move ceiling; hd2 excludes practice unconditionally. */
export function rankedMoveLimit(profile,layoutId) {
  assertProfile(profile);
  if(!Object.hasOwn(CATALOG,layoutId))throw Error('invalid_board');
  if(CATALOG[layoutId].practice)throw Error('practice_layout');
  return profile==='hd1'?Infinity:RANKED_MAX_MOVES[layoutId];
}
/** Check public move eligibility without mutating or replacing actual local evidence. */
export function assertRankedMoves(profile,layoutId,moves) {
  const maximum=rankedMoveLimit(profile,layoutId);
  if(!Number.isSafeInteger(moves)||moves<1)throw Error('invalid_replay');
  if(moves>maximum)throw Error('ranked_move_limit');
}

/** Expand and validate a complete rectangular board. */
export function positions(board) {
  if (typeof board !== 'string' || !/^[A-J.]{20}$/.test(board)) throw Error('invalid_board');
  const result = SHAPES.map((shape,index) => board.indexOf(String.fromCharCode(65+index)));
  if (result.some(position => position < 0) || occupancy(result) !== board) throw Error('invalid_board');
  return result;
}
/** Serialize positions with overlap and bounds checks. */
export function occupancy(state) {
  const cells = Array(20).fill('.');
  state.forEach((position,index) => {
    const [width,height] = SHAPES[index], x=position%4, y=Math.floor(position/4);
    if (!Number.isInteger(position) || position<0 || x+width>4 || y+height>5) throw Error('invalid_board');
    for(let dy=0;dy<height;dy++) for(let dx=0;dx<width;dx++) {
      const cell=(y+dy)*4+x+dx;
      if(cells[cell]!=='.') throw Error('overlap');
      cells[cell]=String.fromCharCode(65+index);
    }
  });
  return cells.join('');
}
/** Apply exactly one successful single-cell action, never a jump. */
export function step(state,symbol) {
  const action=ALPHABET.indexOf(symbol);
  if(symbol.length!==1 || action<0 || action>=40 || state[0]===13) throw Error('invalid_move');
  const piece=Math.floor(action/4), [dx,dy]=DIRECTIONS[action%4];
  const [width,height]=SHAPES[piece], x=state[piece]%4+dx, y=Math.floor(state[piece]/4)+dy;
  if(x<0 || y<0 || x+width>4 || y+height>5) throw Error('invalid_move');
  const next=state.slice();next[piece]=y*4+x;
  occupancy(next);
  return next;
}
/** Replay the entire actual path and derive integer half-up points. */
export function replay(claim,{allowPractice=false}={}) {
  assertProfile(claim.p);
  const layout=CATALOG[claim.l];
  if(!layout || claim.b!==layout.board) throw Error('invalid_board');
  if(layout.practice && (!allowPractice || claim.p===RANKED_PROFILE)) throw Error('practice_layout');
  if(typeof claim.m!=='string' || !claim.m.length) throw Error('invalid_replay');
  if(claim.p===RANKED_PROFILE)assertRankedMoves(claim.p,claim.l,claim.m.length);
  let state=positions(claim.b);
  for(const symbol of claim.m) state=step(state,symbol);
  if(state[0]!==13 || claim.m.length<layout.optimum) throw Error('invalid_replay');
  const moves=claim.m.length, square=BigInt(moves)**2n;
  return {moves,points:Number((20n*BigInt(layout.optimum)**3n+square)/(2n*square)),board:occupancy(state)};
}
/** Inclusion MTP, not a wall clock, establishes the authoritative week. */
export function epoch(mtp) { return Math.floor((mtp-345600)/604800); }
/** Lower median of this block and up to ten preceding canonical timestamps. */
export function medianTime(timestamps) {
  if(!timestamps.length || timestamps.length>11 || timestamps.some(t=>!Number.isSafeInteger(t))) throw Error('invalid_headers');
  const sorted=timestamps.slice().sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)/2)];
}
/** A strict improvement in either projection qualifies; time never breaks ties. */
export function improves(moves,lifetime=Infinity,weekly=Infinity) { return moves<lifetime || moves<weekly; }
