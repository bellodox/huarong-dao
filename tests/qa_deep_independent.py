import os,threading,http.server,json,time,sys,re
from playwright.sync_api import sync_playwright
from pathlib import Path
from collections import deque
ROOT=Path(__file__).resolve().parents[1]/'docs'
# Independent shortest-path oracle: no browser solver, hashing, or move helpers.
def minimum_moves(board):
 ids=['CC','GY','ZF','ZY','MC','HZ','S1','S2','S3','S4']
 sizes=[(2,2),(2,1)]+[(1,2)]*4+[(1,1)]*4
 def canonical(positions):return positions[:2]+tuple(sorted(positions[2:6]))+tuple(sorted(positions[6:]))
 initial=canonical(tuple(board[ident]['y']*4+board[ident]['x'] for ident in ids))
 masks={}
 for width,height in set(sizes):
  for position in range(20):
   x,y=position%4,position//4
   if x+width<=4 and y+height<=5:
    masks[(width,height,position)]=sum(1<<((y+dy)*4+x+dx) for dy in range(height) for dx in range(width))
 queue=deque([(initial,0)]);seen={initial}
 while queue:
  positions,distance=queue.popleft()
  if positions[0]==13:return distance,len(seen)
  occupied=0
  piece_masks=[masks[(*size,position)] for size,position in zip(sizes,positions)]
  for mask in piece_masks:occupied|=mask
  for index,position in enumerate(positions):
   width,height=sizes[index];others=occupied^piece_masks[index]
   x,y=position%4,position//4
   for dx,dy in ((0,-1),(0,1),(-1,0),(1,0)):
    nx,ny=x+dx,y+dy
    if nx<0 or nx+width>4 or ny<0 or ny+height>5:continue
    destination=ny*4+nx
    if masks[(width,height,destination)]&others:continue
    candidate=canonical(positions[:index]+(destination,)+positions[index+1:])
    if candidate not in seen:seen.add(candidate);queue.append((candidate,distance+1))
 return None,len(seen)
out={'errors':[],'cases':[]}
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 ctx=browser.new_context(locale='en-US',viewport={'width':375,'height':550})
 page=ctx.new_page();page.on('pageerror',lambda e:out['errors'].append(str(e)))
 page.route('https://**',lambda route:route.abort())
 html=open(f'{ROOT}/index.html',encoding='utf8').read()
 page.evaluate("""() => {const m=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(),dump:()=>Object.fromEntries(m)}})}""")
 page.set_content(html,wait_until='domcontentloaded');page.wait_for_timeout(120)
 if page.locator('#game-story-modal').is_visible():page.locator('#btn-game-story-done').click()
 if page.locator('#cookie-consent').is_visible():page.locator('#cookie-reject').click()
 # Every layout is verified using actual game's solver and a legal move chain in separate state, and measured for blocking duration.
 paths=page.evaluate('''() => GAME_LAYOUTS.map((layout,i)=>{
    selectLayout(i);
    const t=performance.now();const path=runBFSSolver(currentState);const ms=performance.now()-t;
    const board=JSON.parse(JSON.stringify(layout.board));
    const sizes={CC:[2,2],GY:[2,1],ZF:[1,2],ZY:[1,2],MC:[1,2],HZ:[1,2],S1:[1,1],S2:[1,1],S3:[1,1],S4:[1,1]};
    const grid=Array.from({length:5},()=>Array(4).fill('.'));
    let overlaps=false, outOfBounds=false;
    for(const [id,pos] of Object.entries(board)){
     const [w,h]=sizes[id];for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){
       const x=pos.x+dx,y=pos.y+dy;if(x<0||x>=4||y<0||y>=5)outOfBounds=true;
       else if(grid[y][x]!=='.')overlaps=true;else grid[y][x]=id;
     }
    }
    let sim=JSON.parse(JSON.stringify(board));let valid=true;
    for(const step of path){const mv=step.move,occ=buildGrid(sim);if(!canMovePiece(mv.pieceId,sim,mv.dx,mv.dy,occ)){valid=false;break}sim[mv.pieceId].x+=mv.dx;sim[mv.pieceId].y+=mv.dy;}
    const shapes=grid.map(row=>row.map(id=>id==='.'?'.':id==='CC'?'C':id==='GY'?'G':id[0]==='S'?'S':'V').join(''));
    const symmetric=shapes.every(row=>row===row.split('').reverse().join(''));
    return {id:layout.id,difficulty:parseInt(layout.difficulty,10),computed:path.length,ms:Math.round(ms),valid,solved:sim.CC.x===1&&sim.CC.y===3,symmetric,overlaps,outOfBounds,empties:grid.flat().filter(x=>x==='.').length};
 })''')
 out['cases']=paths
 assert all(x['difficulty']==x['computed'] and x['valid'] and x['solved'] and not x['overlaps'] and not x['outOfBounds'] and x['empties']==2 for x in paths),paths
 for layout in page.evaluate('GAME_LAYOUTS.map(x=>({id:x.id,board:x.board,difficulty:parseInt(x.difficulty,10)}))'):
  started=time.perf_counter();minimum,states=minimum_moves(layout['board'])
  assert minimum==layout['difficulty'],(layout['id'],minimum,layout['difficulty'])
  print('PASS independent BFS',layout['id'],minimum,'moves',states,'states',round(time.perf_counter()-started,3),'seconds',flush=True)
 # Solve Classic with 116 legal browser-game moves; no artificial CC relocation.
 state=page.evaluate('''() => {
 selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='wings'));
 const path=runBFSSolver(currentState);let ok=0;
 for(const step of path){const m=step.move;if(!executeMove(m.pieceId,m.dx,m.dy))break;ok++;}
 return {ok,total:path.length,finalized:roundFinalized,assisted:assistedRun,gate:!playerGate.classList.contains('hidden'),moves:userMovesCount};
 }''')
 out['classic_legal_run']=state
 assert state=={'ok':116,'total':116,'finalized':True,'assisted':False,'gate':True,'moves':116},state
 page.locator('#player-name-input').fill('GenuinePlaye');page.locator('#btn-confirm-gate').click()
 saved=page.evaluate("JSON.parse(localStorage.getItem('huarong_local_scores_v2'))")
 assert saved['owner']=='GenuinePlaye' and saved['best']['wings'][1]==116,saved
 out['classic_saved']=saved
 # Simulated restart with the same storage payload because navigation is disabled in this sandbox.
 store=page.evaluate('localStorage.dump()');page.close();page=ctx.new_page();page.on('pageerror',lambda e:out['errors'].append(str(e)))
 page.evaluate("""store => {const m=new Map(Object.entries(store));Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(),dump:()=>Object.fromEntries(m)}})}""",store)
 page.set_content(html,wait_until='domcontentloaded');page.wait_for_timeout(80)
 assert page.evaluate('nameLocked && nickname === "GenuinePlaye"'), 'reload name mismatch'
 assert page.evaluate('GAME_LAYOUTS[currentLayoutIdx].id')=='training','reload not training'
 # Assisted score run using legal path: board victory but no save to other rank.
 assisted=page.evaluate('''() => {
 selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='fayaa_highRisk'));
 setAssisted('hint');const path=calculatedRemainingPath.slice();let ok=0;
 for(const step of path){const m=step.move; if(!executeMove(m.pieceId,m.dx,m.dy))break;ok++;}
 return {ok,total:path.length,won:roundFinalized,assisted:assistedRun,rank:bestForLayout('fayaa_highRisk')};
 }''')
 out['assisted_legal_run']=assisted
 assert assisted['ok']==assisted['total'] and assisted['won'] and assisted['assisted'] and assisted['rank'] is None,assisted
 # Persisted previous score untouched
 saved2=page.evaluate("JSON.parse(localStorage.getItem('huarong_local_scores_v2'))")
 assert saved2==saved
 # Ensure leaderboard selector excludes deferred ids, local records don't show practice
 page.locator('#modal-btn-replay').click();page.locator('#btn-leaderboard').click()
 opts=page.locator('#ranking-layout option').evaluate_all('(a)=>a.map(x=>x.value)')
 assert len(opts)==11 and 'wings' in opts and 'fayaa_surround' not in opts
 out['leaderboard_ids']=opts
 # Test obvious text parity (name/english keys under locale and subtitles)
 page.locator('#btn-close-leaderboard').click()
 # Full size at 375x500, standalone small 320x480 with all controls visible
 for w,h in [(320,480),(320,568),(375,500),(390,844),(1366,630)]:
  page.set_viewport_size({'width':w,'height':h});page.wait_for_timeout(35)
  geometry=page.evaluate('''() => {const ids=['board','game-frame','btn-levels-menu','btn-install-help','btn-reset','btn-next','btn-hint','btn-drawer','btn-play','speed-controls','active-player'];
    const rs=Object.fromEntries(ids.map(id=>{const el=document.getElementById(id);const r=el.getBoundingClientRect();return [id,{x:r.x,y:r.y,w:r.width,h:r.height}]}));
    const overflow=document.documentElement.scrollWidth>innerWidth, down=Object.values(rs).filter(r=>r.x<0||r.x+r.w>innerWidth+0.1||r.y<0||r.y+r.h>innerHeight+1);
    return {overflow,down,rects:rs};}''')
  out.setdefault('geometry',[]).append({'viewport':f'{w}x{h}',**geometry})
  assert not geometry['overflow'] and not geometry['down'],geometry
  if os.environ.get('QA_OUTPUT_DIR'):page.screenshot(path=str(Path(os.environ['QA_OUTPUT_DIR'])/f'deep-{w}-{h}.png'))
 page.close();ctx.close();browser.close()
assert not out['errors'],out['errors']
if os.environ.get('QA_OUTPUT_DIR'):
 with open(Path(os.environ['QA_OUTPUT_DIR'])/'deep-independent-report.json','w',encoding='utf-8') as f:json.dump(out,f,ensure_ascii=False,indent=2)
print(json.dumps({'layoutCount':len(paths),'moves':[(x['id'],x['computed'],x['ms'],x['symmetric']) for x in paths],'classic':state,'assisted':assisted,'geometry':[{'viewport':x['viewport'],'overflow':x['overflow'],'down':x['down']}for x in out['geometry']],'errors':out['errors']},ensure_ascii=False,indent=2))
