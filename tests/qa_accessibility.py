from playwright.sync_api import sync_playwright
from pathlib import Path
import json
h=(Path(__file__).resolve().parents[1]/'public'/'index.html').read_text(encoding='utf-8')
report=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 for locale in ['bg-BG','en-US']:
  ctx=b.new_context(locale=locale,viewport={'width':320,'height':480})
  page=ctx.new_page()
  page.evaluate("""() => {const m=new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear()}})}""")
  page.set_content(h,wait_until='domcontentloaded');page.wait_for_timeout(130)
  if page.locator('#game-story-modal').is_visible():page.locator('#btn-game-story-done').click()
  page.locator('#cookie-reject').click()
  for target,close in [('btn-drawer','btn-close-drawer'),('btn-levels-menu','btn-close-levels'),('btn-install-help','btn-close-install-help'),('btn-leaderboard','btn-close-leaderboard')]:
   page.locator('#'+target).click();page.wait_for_timeout(50)
   visible=page.locator('#'+close).is_visible()
   focus=page.evaluate('document.activeElement?.id')
   page.keyboard.press('Escape');page.wait_for_timeout(30)
   still=page.locator('#'+close).is_visible()
   el=page.locator('#'+close).bounding_box()
   assert visible and not still,(locale,target,visible,still)
   assert focus==close,(locale,target,focus)
   assert page.evaluate('document.activeElement.id')==target,(locale,target,'focus not restored')
   report.append({'locale':locale,'modal':target,'close_visible':visible,'focus':focus,'escape_closed':not still,'close_button_bounds':el})
   if still:page.locator('#'+close).click()
  ctx.close()
 b.close()
print(json.dumps(report,indent=2,ensure_ascii=False))
