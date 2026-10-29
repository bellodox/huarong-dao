"""Real local workerd + PostgreSQL fixture browser integration. Start runtime_servers.py first."""
import json
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
requests.post('http://127.0.0.1:8788/__fixture/reset',timeout=30).raise_for_status()
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for port in [8787,8788]:
  for locale in ['en-US','bg-BG']:
   if port==8788:requests.post('http://127.0.0.1:8788/__fixture/reset',timeout=30).raise_for_status()
   context=browser.new_context(locale=locale,viewport={'width':390,'height':844})
   page=context.new_page();errors=[];posted=[];requests_seen=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   page.on('request',lambda request:requests_seen.append(request.url))
   page.on('request',lambda request:posted.append(request.post_data) if request.url.endswith('/api/score') else None)
   page.route('https://**',lambda route:route.abort())
   page.goto(f'http://127.0.0.1:{port}/',wait_until='domcontentloaded')
   page.wait_for_function('window.hd1UI!==undefined');page.wait_for_timeout(200)
   page.locator('#btn-game-story-done').click();page.locator('#cookie-reject').click()
   assert page.evaluate("!localStorage.getItem('huarong_rod_identity_v1')")
   assert not any('leaderboard-client.js' in url for url in requests_seen)
   assert page.evaluate('GAME_LAYOUTS[currentLayoutIdx].id')=='training'
   if port==8787:
    page.locator('#btn-leaderboard').click()
    page.screenshot(path=str(ROOT/f'tests/local-disabled-{locale}.png'),full_page=True)
    assert page.evaluate('HUARONG_PUBLIC_ENABLED') is False
    assert not posted
   else:
    page.wait_for_function('HUARONG_PUBLIC_ENABLED===true')
    page.evaluate("selectLayout(GAME_LAYOUTS.findIndex(l=>l.id==='rear_guard'));const path=runBFSSolver(currentState);for(const {move:m} of path)executeMove(m.pieceId,m.dx,m.dy)")
    page.locator('#player-name-input').fill('BrowserPlayer');page.locator('#btn-confirm-gate').click()
    assert page.evaluate('nameLocked') and page.evaluate("!localStorage.getItem('huarong_rod_identity_v1')")
    page.locator('#btn-submit-score').click();page.locator('#public-score-consent').check();page.locator('#btn-confirm-gate').click()
    page.wait_for_function("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1')||'{}') && Object.keys(JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1')||'{}')).length===1")
    page.wait_for_function("document.getElementById('hd1-status').textContent.includes('непотвърдено') || document.getElementById('hd1-status').textContent.includes('unconfirmed')")
    assert len(posted)==1,posted
    body=json.loads(posted[0]);assert list(body)==list('pwlbnms') and len(body['m'])==82 and 'wif' not in posted[0]
    state=requests.get('http://127.0.0.1:8788/__fixture/state',timeout=30).json()
    assert len(state['claims'])==1 and state['claims'][0]['raw'] and state['claims'][0]['state']=='broadcast_unknown',state
    assert state['coordinator']['generation']==1
    # Status GET is read-only. Recoverable statuses retry the same signed POST instead.
    page.route('**/api/submissions/*',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'status':'queued'})))
    page.evaluate('hd1UI.sync()')
    assert len(posted)==2 and posted[0]==posted[1],posted
    page.unroute('**/api/submissions/*')
    recovered=requests.get('http://127.0.0.1:8788/__fixture/state',timeout=30).json()
    assert recovered['coordinator']['generation']==1 and recovered['claims'][0]['raw']==state['claims'][0]['raw']
    public=requests.get('http://127.0.0.1:8788/api/leaderboard',timeout=30)
    assert public.ok and 'max-age=5' in public.headers['Cache-Control']
    assert 'raw' not in public.text and 'prepared' not in public.text
    # Worse lifetime run must remain the chosen actual candidate, not the older optimum.
    page.locator('#modal-btn-replay').click()
    page.evaluate("""() => {selectLayout(GAME_LAYOUTS.findIndex(l=>l.id==='rear_guard'));const grid=buildGrid(currentState);
    const id=Object.keys(currentState).find(id=>DIRECTIONS.some(d=>canMovePiece(id,currentState,d.dx,d.dy,grid)));
    const d=DIRECTIONS.find(d=>canMovePiece(id,currentState,d.dx,d.dy,grid));executeMove(id,d.dx,d.dy);executeMove(id,-d.dx,-d.dy);
    for(const {move:m} of runBFSSolver(currentState))executeMove(m.pieceId,m.dx,m.dy);}""")
    assert page.evaluate("hd1UI.candidate('rear_guard').moves")==84
    page.locator('#modal-btn-replay').click();page.locator('#btn-leaderboard').click()
    page.locator('#ranking-layout').select_option('wings')
    page.wait_for_function("document.getElementById('hd1-rows').childElementCount>0")
    assert page.locator('#hd1-rows').inner_text()
    page.locator('#hd1-scope').select_option('week');page.wait_for_timeout(200)
    assert page.locator('#hd1-rows').inner_text()
    page.screenshot(path=str(ROOT/f'tests/public-fixture-{locale}.png'),full_page=True)
    page.evaluate('setPublicScoreConsent(false)');before=len(posted);page.evaluate('hd1UI.sync()');page.wait_for_timeout(100)
    assert len(posted)==before
    assert page.evaluate('huarongPrivacy.get()') is False
   assert not errors,errors
   print('PASS real workerd browser',port,locale,'walletless view, consent boundary, errors',len(errors),flush=True)
   context.close()
 browser.close()
