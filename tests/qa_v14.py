import os,threading,http.server,socketserver,time,json,sys
from playwright.sync_api import sync_playwright
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'docs'
HTML=open(f'{ROOT}/index.html',encoding='utf-8').read()
fail=[]
def check(ok,desc):
 if not ok:fail.append(desc);print('FAIL',desc)
 else:print('PASS',desc)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for locale in ('bg-BG','en-US'):
  for w,h in [(320,568),(390,844),(1366,768)]:
   ctx=browser.new_context(locale=locale,viewport={'width':w,'height':h},device_scale_factor=1)
   requests=[];errors=[]
   page=ctx.new_page();page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda request:requests.append(request.url))
   page.route('https://www.googletagmanager.com/**',lambda route:route.abort())
   page.evaluate("""() => { const m=new Map(); Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(), dump:()=>Object.fromEntries(m)}}); }""")
   page.set_content(HTML,wait_until='domcontentloaded');page.wait_for_timeout(120)
   if page.locator('#game-story-modal').is_visible():page.locator('#btn-game-story-done').click()
   initial=page.evaluate('''() => ({id:GAME_LAYOUTS[currentLayoutIdx].id,total:GAME_LAYOUTS.length,
    practices:GAME_LAYOUTS.filter(l=>isPracticeLayout(l.id)).map(l=>l.id),
    ranked:GAME_LAYOUTS.filter(l=>!isPracticeLayout(l.id)).length,
    tiers:[...new Set(GAME_LAYOUTS.map(l=>l.tier))],
    nickname:document.getElementById('active-player').getBoundingClientRect().x,
    hintwidth:document.getElementById('hint-banner').getBoundingClientRect().width,
    overflow:document.documentElement.scrollWidth>innerWidth})''')
   check(initial['id']=='training' and initial['total']==14 and initial['ranked']==11,f'{locale} {w}: default Training, 14 layouts, 11 ranked')
   check(initial['practices']==['training','first_steps','next_steps'],f'{locale} {w}: practice 3')
   check(initial['tiers']==[0,4,3,2,1],f'{locale} {w}: tiers ascending difficulty')
   check(not initial['overflow'] and initial['hintwidth']>50,f'{locale} {w}: fit and reserved hint')
   check(page.locator('#beta-version').evaluate('(el)=>el.textContent.includes("0.1.0-beta.3") && el.getBoundingClientRect().height<20'),f'{locale} {w}: visible single-line beta.3 identifier')
   check(page.locator('#cookie-consent').is_visible(),f'{locale} {w}: cookie banner visible')
   check(not any('googletagmanager.com' in u for u in requests),f'{locale} {w}: no analytics before consent')
   check(not errors,f'{locale} {w}: no JS exceptions {errors[:2]}')
   page.locator('#btn-levels-menu').click()
   check(page.locator('#levels-list > h3').count()==5,f'{locale} {w}: tier headings')
   if locale=='en-US':
    check('practice' in page.locator('#levels-list > h3').first.inner_text().lower(),f'{locale} {w}: English tiers')
    check('Privacy and cookies' in page.locator('#cookie-heading').inner_text(),f'{locale} {w}: English cookie text')
   else:
    check('практика' in page.locator('#levels-list > h3').first.inner_text().lower(),f'{locale} {w}: Bulgarian tiers')
   page.locator('#btn-close-levels').click()
   page.locator('#cookie-reject').click()
   check(not page.locator('#cookie-consent').is_visible() and page.evaluate('huarongPrivacy.get()') is False,f'{locale} {w}: reject saves')
   check(not any('googletagmanager.com' in u for u in requests),f'{locale} {w}: reject prevents GA')
   page.locator('#btn-leaderboard').click()
   page.locator('#btn-cookie-settings').click()
   check(page.locator('#cookie-consent').is_visible(),f'{locale} {w}: consent can reopen')
   page.locator('#cookie-accept').click()
   page.wait_for_timeout(100)
   check(page.evaluate('huarongPrivacy.get()') is True and any('googletagmanager.com' in u for u in requests),f'{locale} {w}: GA only after accept')
   page.locator('#btn-leaderboard').click()
   page.locator('#btn-cookie-settings').click();page.locator('#cookie-reject').click()
   check(page.evaluate('window["ga-disable-G-517WKR3J3V"]===true'),f'{locale} {w}: revoke analytics')
   # Practice never saves or locks nickname, not even after a simulated complete board.
   for ident in ('training','first_steps','next_steps'):
    page.evaluate('''id => {selectLayout(GAME_LAYOUTS.findIndex(l=>l.id===id));currentState.CC={x:1,y:3};userMovesCount=77;checkVictory();}''',ident)
    check(page.locator('#player-gate').is_hidden(),f'{locale} {w}: {ident} no identity gate')
    check(page.evaluate('''() => !localStorage.getItem('huarong_local_scores_v2')'''),f'{locale} {w}: {ident} no saved scores')
    page.locator('#modal-btn-replay').click()
   # Save first ranked victory with chosen name and verify locked name + score, reload.
   page.evaluate('''() => {selectLayout(GAME_LAYOUTS.findIndex(l=>l.id==='rear_guard'));currentState.CC={x:1,y:3};userMovesCount=84;checkVictory();}''')
   check(page.locator('#player-gate').is_visible(),f'{locale} {w}: first ranked score requires name')
   page.locator('#player-name-input').fill('TestPlayer')
   page.locator('#btn-confirm-gate').click()
   state=page.evaluate('''() => {const s=JSON.parse(localStorage.getItem('huarong_local_scores_v2')||'null');return {owner:s?.owner,best:s?.best?.rear_guard,lock:nameLocked,shown:document.getElementById('active-player').textContent};}''')
   check(state['owner']=='TestPlayer' and state['best'][1]==84 and state['lock'],f'{locale} {w}: atomic first ranked save')
   dump=page.evaluate('localStorage.dump()')
   page.close()
   page=ctx.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
   page.route('https://www.googletagmanager.com/**',lambda route:route.abort())
   page.evaluate("""dump => {const m=new Map(Object.entries(dump));Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear(),dump:()=>Object.fromEntries(m)}})}""",dump)
   page.set_content(HTML,wait_until='domcontentloaded');page.wait_for_timeout(90)
   check(page.evaluate('''() => nameLocked && nickname==='TestPlayer' && GAME_LAYOUTS[currentLayoutIdx].id==='training' '''),f'{locale} {w}: reload preserves identity, starts Training')
   check(not page.locator('#cookie-consent').is_visible(),f'{locale} {w}: remembered cookie rejection')
   check(not errors,f'{locale} {w}: no JS exceptions final {errors[:2]}')
   if locale=='bg-BG' and os.environ.get('QA_OUTPUT_DIR'):page.screenshot(path=str(Path(os.environ['QA_OUTPUT_DIR'])/f'qa-{w}.png'),full_page=True)
   page.close();ctx.close()
 browser.close()
print('FAIL COUNT',len(fail));sys.exit(1 if fail else 0)
