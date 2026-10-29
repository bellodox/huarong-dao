import json,sys,re
from playwright.sync_api import sync_playwright
from pathlib import Path
from contextlib import ExitStack
HTML=(Path(__file__).resolve().parents[1]/'public'/'index.html').read_text(encoding='utf-8')
REMOVED={'fayaa_surround','fayaa_oneArmy','fayaa_constellation','fayaa_surrounded','fayaa_east','fayaa_leftPawn','fayaa_worse'}
EXPECTED_AFTER={'heng_dao_li_ma','fayaa_rain2','fayaa_cannotStop','fayaa_highRisk'}
MOCK_BEST={'fayaa_surround':['Alice',82,99],'fayaa_worse':['Alice',117,210],'wings':['Alice',121,123]}
seeds={'huarong_local_scores_v2':json.dumps({'v':2,'owner':'Alice','best':MOCK_BEST,'recent':{}},ensure_ascii=False),'huarong_player_name_v1':'Alice','huarong_story_seen_v1':'1','huarong_cookie_choice_v1':'necessary'}
def analytics_withdrawal_regressions(browser):
 defects=[]
 url='http://game.beta2.example.test/index.html'
 for locale in ('en-US','bg-BG'):
  ctx=browser.new_context(locale=locale,viewport={'width':320,'height':480})
  ctx.set_default_timeout(3000)
  requests=[];runtime_errors=[]
  def intercept(route):
   requests.append(route.request.url)
   if route.request.resource_type=='document':route.fulfill(status=200,content_type='text/html',body=HTML)
   else:route.abort()
  ctx.route('**/*',intercept)
  ctx.on('page',lambda page:page.on('pageerror',lambda error:runtime_errors.append(str(error))))
  try:
   page=ctx.new_page();page.goto(url)
   page.evaluate("localStorage.setItem('huarong_story_seen_v1','1');huarongPrivacy.choose(true)")
   peer=ctx.new_page();peer.goto(url)
   assert peer.evaluate('huarongPrivacy.get()') is True
   page.evaluate('huarongPrivacy.choose(false)')
   try:peer.wait_for_function('huarongPrivacy.get()===false && window["ga-disable-G-517WKR3J3V"]===true')
   except Exception:defects.append((locale,'peer retains grant after storage revocation'))
   # A peer accepting must never turn analytics back on in the rejecting tab.
   peer.evaluate('huarongPrivacy.choose(true)')
   page.wait_for_timeout(60)
   if page.evaluate('huarongPrivacy.get()!==false || window["ga-disable-G-517WKR3J3V"]!==true'):
    defects.append((locale,'peer acceptance auto-grants analytics'))
   # Simulate a suspended tab missing storage events; each resume hook must recheck.
   peer.evaluate("window.blockStorage=event=>event.stopImmediatePropagation();window.addEventListener('storage',blockStorage,true)")
   for event in ('focus','pageshow','visibilitychange'):
    peer.evaluate('huarongPrivacy.choose(true)')
    page.evaluate('huarongPrivacy.choose(false)')
    peer.wait_for_timeout(60)
    peer.evaluate("event=>{if(event==='visibilitychange')document.dispatchEvent(new Event(event));else window.dispatchEvent(new Event(event));}",event)
    if peer.evaluate('huarongPrivacy.get()!==false || window["ga-disable-G-517WKR3J3V"]!==true'):
     defects.append((locale,'missed revocation on resume',event))
   peer.evaluate("window.removeEventListener('storage',blockStorage,true)")
   for operation in ('remove','clear'):
    peer.evaluate('huarongPrivacy.choose(true)')
    page.evaluate("operation=>{if(operation==='clear')localStorage.clear();else localStorage.removeItem('huarong_cookie_choice_v1');}",operation)
    try:peer.wait_for_function('huarongPrivacy.get()===false && window["ga-disable-G-517WKR3J3V"]===true')
    except Exception:defects.append((locale,'peer retains grant after storage '+operation))
   peer.close()
   page.evaluate("localStorage.setItem('huarong_story_seen_v1','1')")
   for write_mode in ('throw','drop'):
    for remove_mode in ('works','throw','drop'):
     page.evaluate('huarongPrivacy.choose(true)')
     assert page.evaluate("JSON.parse(localStorage.getItem('huarong_cookie_choice_v1')).analytics") is True
     page.evaluate('''modes=>{
      window.originalSet=Storage.prototype.setItem;window.originalRemove=Storage.prototype.removeItem;
      Storage.prototype.setItem=function(k,v){if(k!=='huarong_cookie_choice_v1')return originalSet.call(this,k,v);if(modes.write==='throw')throw Error('QA consent write');};
      Storage.prototype.removeItem=function(k){if(k!=='huarong_cookie_choice_v1'||modes.remove==='works')return originalRemove.call(this,k);if(modes.remove==='throw')throw Error('QA consent remove');};
      huarongPrivacy.open();
     }''',{'write':write_mode,'remove':remove_mode})
     page.locator('#cookie-reject').focus();page.keyboard.press('Enter')
     assert page.evaluate('huarongPrivacy.get()===false && window["ga-disable-G-517WKR3J3V"]===true')
     saved=page.evaluate("localStorage.getItem('huarong_cookie_choice_v1')")
     if remove_mode=='works':
      if saved is not None and json.loads(saved).get('analytics') is True:
       defects.append((locale,write_mode,'stale grant not invalidated'))
      before=sum('googletagmanager.com/gtag/js' in request for request in requests)
      page.reload();page.wait_for_timeout(60)
      if page.locator('script[src*="googletagmanager"]').count() or sum('googletagmanager.com/gtag/js' in request for request in requests)!=before:
       defects.append((locale,write_mode,'reload loads analytics after withdrawal'))
      if page.evaluate('window["ga-disable-G-517WKR3J3V"]!==true'):
       defects.append((locale,write_mode,'reload not disabled'))
     else:
      status=page.locator('#cookie-save-error')
      expected='Analytics is off in this tab' if locale=='en-US' else 'Анализът е изключен в този раздел'
      if not page.locator('#cookie-consent').is_visible() or not status.count() or not status.is_visible():
       defects.append((locale,write_mode,remove_mode,'durable failure hidden'))
      else:
       assert expected in status.inner_text(),status.inner_text()
       assert status.get_attribute('role')=='alert'
       for button in ('cookie-reject','cookie-accept'):
        bounds=page.locator('#'+button).bounding_box()
        assert bounds and bounds['y']>=0 and bounds['y']+bounds['height']<=480,(locale,button,bounds)
       assert ('reload' in status.inner_text() if locale=='en-US' else 'презареждане' in status.inner_text())
       assert page.evaluate('document.activeElement.id')=='cookie-reject'
       page.keyboard.press('Tab');assert page.evaluate('document.activeElement.id')=='cookie-accept'
      # Retry remains actionable once storage recovers, and clears the warning.
      page.evaluate('Storage.prototype.setItem=originalSet;Storage.prototype.removeItem=originalRemove;void 0')
      if page.locator('#cookie-consent').is_visible():page.locator('#cookie-reject').click()
      else:page.evaluate('huarongPrivacy.choose(false)')
      assert page.locator('#cookie-consent').is_hidden()
      if status.count():assert status.is_hidden()
   assert not runtime_errors,runtime_errors
  finally:ctx.close()
 print('analytics withdrawal defects:',json.dumps(defects,ensure_ascii=False))
 assert not defects,defects
 print('PASS bilingual analytics peer revoke/no-auto-grant, remove/clear, focus/pageshow/visibility resume, thrown/dropped writes, reload and durable-failure feedback/retry; all network intercepted')

errors=[]
with sync_playwright() as p, ExitStack() as cleanup:
 browser=p.chromium.launch(headless=True)
 cleanup.callback(browser.close)
 analytics_withdrawal_regressions(browser)
 if '--analytics-only' in sys.argv:
  print('PASS focused analytics consent tests')
  sys.exit(0)
 for locale in ['bg-BG','en-US']:
  ctx=browser.new_context(locale=locale,viewport={'width':390,'height':844})
  ctx.set_default_timeout(10000)
  page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.evaluate('''seeds => {const m=new Map(Object.entries(seeds));Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(),dump:()=>Object.fromEntries(m)}}); }''',seeds)
  page.set_content(HTML,wait_until='domcontentloaded');page.wait_for_timeout(130)
  r=page.evaluate('''() => {
     const pieces={CC:[2,2],GY:[2,1],ZF:[1,2],ZY:[1,2],MC:[1,2],HZ:[1,2],S1:[1,1],S2:[1,1],S3:[1,1],S4:[1,1]};
     function sym(layout){const grid=Array.from({length:5},()=>Array(4).fill('.'));for(const [id,p] of Object.entries(layout.board)){const [w,h]=pieces[id];const letter=id==='CC'?'C':id==='GY'?'H':id.startsWith('S')?'P':'V';for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++)grid[p.y+yy][p.x+xx]=letter;}return grid.every(row=>row.join('')===row.slice().reverse().join(''));}
     const k=GAME_LAYOUTS.findIndex(x=>x.id==='wings');
     const ranked=GAME_LAYOUTS.filter(x=>!isPracticeLayout(x.id));
     const before=GAME_LAYOUTS.slice(0,k).filter(x=>!isPracticeLayout(x.id));
     const after=GAME_LAYOUTS.slice(k+1).filter(x=>!isPracticeLayout(x.id));
     const stored=JSON.parse(localStorage.getItem('huarong_local_scores_v2'));
     return {start:GAME_LAYOUTS[currentLayoutIdx].id, startName:GAME_LAYOUTS[currentLayoutIdx].name,shownName:document.getElementById('header-layout-name').textContent,startMoves:GAME_LAYOUTS[currentLayoutIdx].difficulty,
       total:GAME_LAYOUTS.length,ranked:ranked.map(x=>x.id),before:before.map(x=>[x.id,sym(x)]),after:after.map(x=>[x.id,sym(x)]),scoreKeys:Object.keys(stored.best), owner:stored.owner, locked:nameLocked};
  }''')
  assert r['start']=='training' and r['startMoves']=='24 хода',r
  assert r['total']==14 and len(r['ranked'])==11,r
  assert all(v for id,v in r['before']),(locale,'preclassic asymmetric',r['before'])
  assert set(id for id,v in r['after'])==EXPECTED_AFTER,r['after']
  assert r['scoreKeys']==list(MOCK_BEST) and r['owner']=='Alice' and r['locked'],r
  assert not REMOVED.intersection(r['ranked']),r
  assert ('Training' in r['shownName'] if locale=='en-US' else 'Тренировка' in r['shownName']),r
  page.locator('#btn-levels-menu').click()
  text=page.locator('#levels-list').inner_text()
  if locale=='en-US':
   assert not re.search(r'[\u0400-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f]',text),('English levels list contains Cyrillic',text)
  assert 'Wings' not in text and 'Криле' not in text,text
  assert ("Zhuge's Eight Formations" in text if locale=='en-US' else 'Осемте формации на Джуге' in text),text
  assert ('Command with Ease' in text if locale=='en-US' else 'Уверено командване' in text),text
  assert ('Four Pawns in a Row' in text if locale=='en-US' else 'Четирима войници в редица' in text),text
  assert all('fayaa_' not in t for t in text.split('\n'))
  names=page.locator('#levels-list h4').all_inner_texts()
  assert len(names)==14 and not any(re.search(r'[⺀-鿿豈-﫿]',n) for n in names),('layout names contain CJK glyphs',names)
  assert page.locator('#btn-levels-menu').inner_text().strip().endswith('Choose Layout' if locale=='en-US' else 'Избери подредба'),page.locator('#btn-levels-menu').inner_text()
  page.locator('#btn-close-levels').click()
  page.locator('#btn-leaderboard').click()
  opts=page.locator('#ranking-layout option').evaluate_all('(els)=>els.map(x=>x.value)')
  assert set(opts)==set(r['ranked']) and not REMOVED.intersection(opts),(locale,opts)
  # Existing stored data is unchanged after the selector/leaderboard opens.
  persisted=page.evaluate("JSON.parse(localStorage.getItem('huarong_local_scores_v2'))")
  assert persisted['best']==MOCK_BEST,(locale,'scores mutated',persisted)
  assert not errors,errors
  print(locale,'PASS',r['startName'],'symmetric pre-classic',len(r['before']),'postclassic',len(r['after']),'retained hidden scores',len(r['scoreKeys']))
  ctx.close()
 # Real cookie/storage lifecycle on a reserved subdomain, with all network traffic intercepted.
 ctx=browser.new_context(locale='en-US')
 ctx.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body=HTML) if route.request.resource_type=='document' else route.abort())
 page=ctx.new_page();page.goto('http://game.beta2.example.test/index.html')
 page.evaluate("localStorage.setItem('huarong_story_seen_v1','1')")
 page.reload()
 page.locator('#btn-levels-menu').click()
 texts=page.locator('#levels-list').inner_text()
 defects=[]
 if 'Save your personal best' in texts or 'First level with local scores' in texts: defects.append('English practice descriptions promise scores')
 onboarding=page.locator('#game-story-modal').text_content()
 if 'You start with Training' not in onboarding or 'Choose Layout' not in onboarding: defects.append('English onboarding contradicts Training startup')
 assert page.locator('#beta-version').inner_text()=='Beta 0.1.0-beta.3'
 page.locator('#btn-close-levels').click()
 ctx.add_cookies([
  {'name':'_ga','value':'parent','domain':'.example.test','path':'/'},
  {'name':'_ga_517WKR3J3V','value':'stream','domain':'.example.test','path':'/'},
  {'name':'_gid','value':'host','url':'http://game.beta2.example.test/'},
  {'name':'unrelated','value':'keep','domain':'.example.test','path':'/'},
 ])
 page.evaluate('huarongPrivacy.choose(true);huarongPrivacy.choose(false)')
 cookies=ctx.cookies()
 if any(c['name'].startswith('_ga') or c['name']=='_gid' for c in cookies): defects.append('Withdrawal retains GA parent-domain/root cookies')
 assert any(c['name']=='unrelated' and c['value']=='keep' for c in cookies),cookies
 # Simulate an old analytics cookie arriving after withdrawal, then navigate/reload.
 ctx.add_cookies([{'name':'_ga','value':'stale','domain':'.example.test','path':'/'}])
 page.reload()
 resumed=page.evaluate('({choice:huarongPrivacy.get(),disabled:window["ga-disable-G-517WKR3J3V"]===true,tags:document.querySelectorAll("script[src*=googletagmanager]").length})')
 if resumed!={'choice':False,'disabled':True,'tags':0}: defects.append('Reload does not enforce remembered analytics rejection: '+str(resumed))
 if any(c['name'].startswith('_ga') or c['name']=='_gid' for c in ctx.cookies()): defects.append('Reload retains stale analytics cookies')
 print('beta.3 regression defects:',json.dumps(defects))
 assert not defects,defects
 print('PASS beta.3 translation and real parent-domain/root/reload cookie regressions')
 # Native storage, real navigation, two tabs, and controlled write failures.
 page.evaluate('localStorage.clear()');page.reload()
 page.locator('#btn-game-story-done').click();page.locator('#cookie-reject').click()
 peer=ctx.new_page();peer.goto('http://game.beta2.example.test/index.html')
 previous=page.evaluate('nickname')
 page.evaluate("selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='rear_guard'));currentState.CC={x:1,y:3};userMovesCount=84;checkVictory();window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===SCORE_STORE_V2_KEY)throw Error('QA quota');return originalSet.call(this,k,v)};void 0")
 page.locator('#player-name-input').fill('BetaPlayer');page.locator('#btn-confirm-gate').click()
 assert page.evaluate('!nameLocked && !localStorage.getItem(SCORE_STORE_V2_KEY) && nickname=== '+json.dumps(previous))
 print('PASS first-score quota failure rolls nickname back without lock')
 page.evaluate('Storage.prototype.setItem=function(k,v){if(k!==SCORE_STORE_V2_KEY)return originalSet.call(this,k,v)};void 0')
 page.locator('#btn-confirm-gate').click()
 assert page.evaluate('!nameLocked && !localStorage.getItem(SCORE_STORE_V2_KEY)')
 print('PASS silent score-write loss fails readback verification without lock')
 page.evaluate('Storage.prototype.setItem=originalSet;void 0');page.locator('#btn-confirm-gate').click()
 assert page.evaluate('nameLocked && nickname==="BetaPlayer" && JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY)).owner==="BetaPlayer"')
 peer.wait_for_function('nameLocked && nickname==="BetaPlayer"')
 assert peer.evaluate('saveNickname("OtherPlayer")') is False
 assert page.evaluate('storeVictory("rear_guard",84,0,true);recentScores.rear_guard.length')==1
 print('PASS durable first-score commit, cross-tab identity lock, duplicate result idempotency')
 page.reload()
 assert page.evaluate('nameLocked && nickname==="BetaPlayer" && GAME_LAYOUTS[currentLayoutIdx].id==="training"')
 page.evaluate("window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===SCORE_STORE_V2_KEY)throw Error('QA quota');return originalSet.call(this,k,v)};selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='rear_guard'));currentState.CC={x:1,y:3};userMovesCount=83;checkVictory()")
 assert page.evaluate('pendingLocalScore!==null && bestForLayout("rear_guard")[1]===84')
 page.evaluate('Storage.prototype.setItem=originalSet;void 0');page.locator('#retry-score').click()
 assert page.evaluate('pendingLocalScore===null && bestForLayout("rear_guard")[1]===83 && recentScores.rear_guard.length===2')
 print('PASS native reload and failed locked-score retry preserves best/history')
 page.evaluate("Storage.prototype.setItem=function(k,v){if(k===SCORE_STORE_V2_KEY)throw Error('QA quota');return originalSet.call(this,k,v)};selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='rear_guard'));currentState.CC={x:1,y:3};userMovesCount=82;checkVictory();Storage.prototype.setItem=originalSet;selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='wings'));document.getElementById('retry-score').click()")
 assert page.evaluate('bestForLayout("rear_guard")[1]===83 && recentScores.rear_guard.length===2')
 page.evaluate("for(let i=0;i<7;i++){selectLayout(GAME_LAYOUTS.findIndex(x=>x.id==='rear_guard'));currentState.CC={x:1,y:3};userMovesCount=90+i;checkVictory()}")
 assert page.evaluate('bestForLayout("rear_guard")[1]===83 && recentScores.rear_guard.length===5')
 print('PASS stale retry rejected and permanent best survives rolling five-result history')
 peer.close()
 page.evaluate("localStorage.clear();localStorage.setItem(SCORE_STORE_V2_KEY,JSON.stringify({v:2,owner:'OldPractice',best:{first_steps:['OldPractice',32,1]},recent:{}}));localStorage.setItem(FIXED_NAME_KEY,'OldPractice')")
 page.reload()
 assert page.evaluate('!nameLocked && !localStorage.getItem(FIXED_NAME_KEY)')
 print('PASS legacy practice-only scores do not commit an owner or fixed name')
 ctx.close()
 browser.close()
print('PASS all edge tests')
