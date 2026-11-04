from playwright.sync_api import sync_playwright
from pathlib import Path
from contextlib import ExitStack
html=(Path(__file__).resolve().parents[1]/'public'/'index.html').read_text(encoding='utf-8')
with sync_playwright() as p, ExitStack() as cleanup:
 b=p.chromium.launch(headless=True)
 cleanup.callback(b.close)
 for locale in ('en-US','bg-BG'):
  ctx=b.new_context(locale=locale,viewport={'width':320,'height':568})
  ctx.set_default_timeout(10000)
  page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.evaluate("""() => {const m=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear()}})}""")
  page.set_content(html,wait_until='domcontentloaded');page.wait_for_timeout(40)
  if page.locator('#game-story-modal').is_visible():page.locator('#btn-game-story-done').click()
  page.locator('#cookie-reject').click()
  page.locator('#btn-levels-menu').click()
  assert page.evaluate('document.activeElement.id')=='btn-close-levels'
  page.keyboard.press('Shift+Tab')
  assert page.evaluate('document.activeElement.closest("#levels-list") !== null')
  page.keyboard.press('Tab')
  assert page.evaluate('document.activeElement.id')=='btn-close-levels'
  page.keyboard.press('Tab')
  assert page.evaluate('document.activeElement.closest("#levels-list") !== null')
  page.keyboard.press('Enter')
  assert page.evaluate('GAME_LAYOUTS[currentLayoutIdx].id')=='training'
  assert page.locator('#levels-modal').is_hidden()
  assert page.evaluate('document.activeElement.id')=='btn-levels-menu'
  # Practice completion still never saves.
  page.locator('#btn-drawer').click()
  assert page.evaluate('document.activeElement.id')=='btn-close-drawer'
  page.keyboard.press('Tab')
  assert page.evaluate('document.activeElement.id')=='btn-close-drawer'
  page.keyboard.press('Escape')
  assert page.locator('#moves-drawer').is_hidden()
  assert page.evaluate('document.activeElement.id')=='btn-drawer'
  # Neither dialog influences score storage; mouse click outside also closes.
  page.locator('#btn-levels-menu').click()
  page.locator('#levels-modal').click(position={'x':2,'y':2},force=True)
  assert page.locator('#levels-modal').is_hidden()
  assert page.evaluate('document.activeElement.id')=='btn-levels-menu'
  # Opening cookie settings from the leaderboard must hand off keyboard focus.
  page.locator('#btn-leaderboard').focus()
  page.keyboard.press('Enter')
  assert page.locator('#leaderboard-modal').is_visible(),'Keyboard must open the leaderboard'
  assert page.evaluate('document.activeElement.id')=='btn-close-leaderboard'
  # Roving inactive tabs must not become unreachable focus-trap endpoints.
  for key in ['Tab']*16+['Shift+Tab']*16:
   page.keyboard.press(key)
   assert page.evaluate('document.activeElement.closest("#leaderboard-modal") !== null'),'Focus escaped the ranking dialog'
  page.locator('#btn-close-leaderboard').focus()
  # Navigate the actual tabbed settings panel without bypassing focus handling.
  for _ in range(20):
   page.keyboard.press('Tab')
   assert page.evaluate('document.activeElement.closest("#leaderboard-modal") !== null')
   if page.evaluate('document.activeElement.getAttribute("role")')=='tab':break
  assert page.evaluate('document.activeElement.getAttribute("role")')=='tab'
  for _ in range(3):
   if page.evaluate('document.activeElement.id')=='ranking-tab-settings':break
   page.keyboard.press('ArrowRight')
  assert page.evaluate('document.activeElement.id')=='ranking-tab-settings'
  page.keyboard.press('Enter')
  assert page.locator('#ranking-pane-settings').is_visible()
  for _ in range(20):
   page.keyboard.press('Tab')
   assert page.evaluate('document.activeElement.closest("#leaderboard-modal") !== null')
   if page.evaluate('document.activeElement.id')=='btn-cookie-settings':break
  assert page.evaluate('document.activeElement.id')=='btn-cookie-settings','Keyboard must reach cookie settings in the settings tab'
  page.keyboard.press('Enter')
  assert page.locator('#leaderboard-modal').is_hidden(),'Cookie settings must hide the leaderboard'
  assert page.evaluate('document.activeElement.id')=='cookie-reject','Cookie settings must focus Reject'
  page.keyboard.press('Tab')
  assert page.evaluate('document.activeElement.id')=='cookie-accept','Tab from Reject must reach Accept'
  page.keyboard.press('Shift+Tab')
  assert page.evaluate('document.activeElement.id')=='cookie-reject','Shift+Tab from Accept must return to Reject'
  assert page.evaluate('huarongPrivacy.get()') is False,'Opening settings must not opt into analytics'
  assert page.locator('script[src*="googletagmanager"]').count()==0,'Opening settings must not load analytics'
  page.keyboard.press('Enter')
  assert page.locator('#cookie-consent').is_hidden(),'Keyboard Reject must dismiss cookie settings'
  assert page.evaluate('huarongPrivacy.get()') is False,'Keyboard Reject must preserve analytics rejection'
  page.locator('#btn-leaderboard').focus()
  page.keyboard.press('Enter')
  assert page.locator('#leaderboard-modal').is_visible()
  page.keyboard.press('Escape')
  assert page.locator('#leaderboard-modal').is_hidden(),'Escape must close the leaderboard'
  assert page.evaluate('document.activeElement.id')=='btn-leaderboard','Leaderboard Escape must restore its opener'
  assert not errors,errors
  print(locale,'keyboard dialog navigation PASS')
  ctx.close()
 b.close()
