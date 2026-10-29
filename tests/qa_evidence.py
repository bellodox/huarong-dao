"""Browser capture plus independent Python replay; writes public deterministic fixtures only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
IDS=['CC','ZY','ZF','MC','HZ','GY','S1','S2','S3','S4']
SHAPES=[(2,2)]+[(1,2)]*4+[(2,1)]+[(1,1)]*4
ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
def replay(evidence):
 board=evidence['b']; state=[board.index(chr(65+i)) for i in range(10)]
 def cells():
  grid=['.']*20
  for i,(position,(width,height)) in enumerate(zip(state,SHAPES)):
   x,y=position%4,position//4
   assert 0<=x<=4-width and 0<=y<=5-height
   for dy in range(height):
    for dx in range(width):
     cell=(y+dy)*4+x+dx
     assert grid[cell]=='.'
     grid[cell]=chr(65+i)
  return ''.join(grid)
 assert cells()==board
 for symbol in evidence['m']:
  assert state[0]!=13
  action=ALPHABET.index(symbol);assert action<40
  piece,direction=divmod(action,4);dx,dy=[(0,-1),(1,0),(0,1),(-1,0)][direction]
  x,y=state[piece]%4+dx,state[piece]//4+dy
  assert x>=0 and y>=0 and x+SHAPES[piece][0]<=4 and y+SHAPES[piece][1]<=5
  state[piece]=y*4+x;cells()
 assert state[0]==13
 return cells()
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(locale='en-US')
 errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
 page.route('https://**',lambda route:route.abort())
 page.evaluate("""() => {const m=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}})}""")
 page.set_content((ROOT/'public/index.html').read_text(encoding='utf-8'))
 fixtures=page.evaluate('''() => GAME_LAYOUTS.map((layout,index)=>{
  selectLayout(index);
  const before=runEvidence.m;executeMove('CC',0,0);executeMove('CC',2,0);
  if(runEvidence.m!==before)throw Error('Rejected gesture appended');
  const path=runBFSSolver(currentState);
  for(const {move} of path)if(!executeMove(move.pieceId,move.dx,move.dy))throw Error('Illegal solver path');
  return {...runEvidence,optimum:parseInt(layout.difficulty,10),moves:userMovesCount,practice:isPracticeLayout(layout.id)};
 })''')
 for fixture in fixtures:
  replay(fixture);assert len(fixture['m'])==fixture['moves']==fixture['optimum']
 page.evaluate("selectLayout(GAME_LAYOUTS.findIndex(l=>l.id==='rear_guard')); const path=runBFSSolver(currentState); for(const {move:m} of path)executeMove(m.pieceId,m.dx,m.dy)")
 page.locator('#player-name-input').fill('ReplayPlayer');page.locator('#btn-confirm-gate').click()
 saved=page.evaluate("JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY))")
 assert len(saved['evidence'])==1 and saved['owner']=='ReplayPlayer'
 replay(next(iter(saved['evidence'].values())))
 # A worse run still carries its own path, even when the lifetime record is better.
 page.evaluate("""() => {selectLayout(GAME_LAYOUTS.findIndex(l=>l.id==='rear_guard'));
 const grid=buildGrid(currentState), id=Object.keys(currentState).find(id=>DIRECTIONS.some(d=>canMovePiece(id,currentState,d.dx,d.dy,grid)));
 const d=DIRECTIONS.find(d=>canMovePiece(id,currentState,d.dx,d.dy,grid));executeMove(id,d.dx,d.dy);executeMove(id,-d.dx,-d.dy);
 for(const {move:m} of runBFSSolver(currentState))executeMove(m.pieceId,m.dx,m.dy);} """)
 saved=page.evaluate("JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY))")
 assert saved['best']['rear_guard'][1]==82 and sorted(e['moves'] for e in saved['evidence'].values())==[82,84]
 for evidence in saved['evidence'].values():replay(evidence)
 page.evaluate("selectLayout(0);setAssisted('hint')")
 assert page.evaluate('runEvidence.assisted')
 page.evaluate('selectLayout(0)');assert page.evaluate('runEvidence.m.length===0 && !runEvidence.assisted')
 assert not errors,errors
 browser.close()
(ROOT/'tests/fixtures').mkdir(exist_ok=True)
(ROOT/'tests/fixtures/paths.json').write_text(json.dumps(fixtures,indent=2),encoding='utf-8')
print('PASS 14 browser paths independently replayed; rejected gestures, exact counts, reset/assistance, atomic evidence, weekly-only 84 vs lifetime 82; 0 page errors')
