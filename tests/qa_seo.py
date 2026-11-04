"""Static SEO and consent/startup browser checks against runtime_servers.py loopback servers."""
import json
from pathlib import Path
from xml.etree import ElementTree
from playwright.sync_api import sync_playwright

ORIGIN='https://huarong-dao.spacexpanseorg.workers.dev/'
ROOT=Path(__file__).resolve().parents[1]
VIEWPORTS=[(320,480),(320,568),(390,844),(768,900),(1024,900),(1440,900)]


def snapshot(page):
 return page.evaluate('''() => ({
  lang:document.documentElement.lang,title:document.title,
  meta:Object.fromEntries([...document.head.querySelectorAll('meta[name],meta[property]')].map(el=>[el.name||el.getAttribute('property'),el.content])),
  canonical:document.querySelector('link[rel="canonical"]').href,
  alternates:document.querySelectorAll('link[hreflang]').length,
  explanation:document.getElementById('game-explanation').textContent,
  structured:document.querySelector('script[type="application/ld+json"]').textContent
 })''')


def metadata_check(state,language):
 assert state['lang']==language
 assert state['canonical']==ORIGIN and state['alternates']==0
 meta=state['meta']
 assert meta['og:url']==ORIGIN
 assert meta['og:title']==meta['twitter:title']==state['title']
 assert meta['description']==meta['og:description']==meta['twitter:description']
 assert meta['og:image']==meta['twitter:image']==ORIGIN+'social-preview.png'
 assert meta['og:image:alt']==meta['twitter:image:alt']
 assert meta['og:locale']==('bg_BG' if language=='bg' else 'en_US')
 assert meta['og:locale:alternate']==('en_US' if language=='bg' else 'bg_BG')
 assert ('Тренировка' if language=='bg' else 'Training') in state['explanation']
 assert ('Играй' if language=='bg' else 'Play') in meta['description']
 assert ('Хуаронг' if language=='bg' else 'Huarong') in state['title']
 expected={
  'bg':{
   'title':'Хуаронг Дао (Klotski) — играй безплатно онлайн',
   'description':'Играй Хуаронг Дао (Klotski) безплатно в браузъра. Започни с Тренировка, пробвай 14 подредби или ползвай подсказки и автоматично решение на устройството.',
   'alt':'Huarong Dao / Klotski. Английски надпис: „Можеш ли да освободиш червения блок?“. Дъската от Тренировка с изход долу по средата. Безплатно в браузъра · 14 подредби · подсказки.',
   'explanation':'Хуаронг Дао (Klotski): можеш ли да изведеш червения блок през изхода долу по средата? Плъзгай фигурите. Започни с Тренировка.'},
  'en':{
   'title':'Huarong Dao (Klotski) — Play Free Online',
   'description':'Play Huarong Dao (Klotski) free in your browser. Start with Training, try 14 layouts, or get unstuck with hints and an automatic solver running on your device.',
   'alt':'Huarong Dao / Klotski. Can you free the red block? The Training board with a bottom-center exit. Free browser play · 14 layouts · hints.',
   'explanation':'Huarong Dao (Klotski): can you free the red block through the bottom-center exit? Slide the pieces. Start with Training.'}
 }[language]
 assert state['title']==expected['title']
 assert meta['description']==expected['description']
 assert meta['og:image:alt']==expected['alt']
 assert state['explanation']==expected['explanation']


def geometry_check(page):
 geometry=page.evaluate('''() => {
  const ids=['game-explanation','game-frame','board','exit-passage','btn-reset','btn-language'];
  const bounds=Object.fromEntries(ids.map(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();
   return [id,{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,scroll:el.scrollHeight,client:el.clientHeight}];}));
  return {bounds,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};
 }''')
 assert not geometry['overflow'],geometry
 for name,box in geometry['bounds'].items():
  assert box['width']>0 and box['height']>0,(name,geometry)
  assert box['x']>=-1 and box['y']>=-1 and box['right']<=geometry['width']+1 and box['bottom']<=geometry['height']+1,(name,geometry)
 explanation=geometry['bounds']['game-explanation']
 assert explanation['scroll']<=explanation['client']+1,geometry
 assert explanation['bottom']<=geometry['bounds']['game-frame']['y'],geometry
 assert geometry['bounds']['game-frame']['bottom']<=page.locator('body > footer').bounding_box()['y']+1,geometry
 return geometry['bounds']['board']['height']


with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 print('Chromium',browser.version,flush=True)
 for port in [8787,8788]:
  base=f'http://127.0.0.1:{port}/'
  for locale in ['bg-BG','en-US']:
   context=browser.new_context(locale=locale,viewport={'width':320,'height':480})
   page=context.new_page();errors=[];console_errors=[];requests=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   page.on('console',lambda message:console_errors.append(message.text) if message.type=='error' else None)
   page.on('request',lambda request:requests.append((request.method,request.url)))
   page.route('https://**',lambda route:route.abort())
   response=page.goto(base,wait_until='domcontentloaded');assert response.status==200
   page.wait_for_function('window.hd1UI!==undefined')
   page.locator('#game-story-modal').wait_for(state='visible')
   assert page.evaluate('document.activeElement.id')=='btn-close-game-story'
   assert not page.locator('#story-literary-details').get_attribute('open')
   page.locator('#btn-game-story-done').click()
   assert page.locator('#cookie-consent').is_visible()
   assert page.evaluate("GAME_LAYOUTS[currentLayoutIdx].id==='training' && !solverEnabled && !assistedRun && userMovesCount===0")
   assert page.locator('#board > .tile').count()==10
   page.locator('#cookie-reject').click()
   assert page.evaluate('huarongPrivacy.get()===false')
   initial=snapshot(page);language='bg' if locale=='bg-BG' else 'en'
   metadata_check(initial,language)
   observations=[]
   for width,height in VIEWPORTS:
    page.set_viewport_size({'width':width,'height':height})
    for expected in [language,'en' if language=='bg' else 'bg',language]:
     if snapshot(page)['lang']!=expected:
      page.locator('#btn-language').focus();page.keyboard.press('Enter')
     page.wait_for_timeout(50)
     state=snapshot(page);metadata_check(state,expected)
     assert state['structured']==initial['structured']
     observations.append({'viewport':f'{width}x{height}','language':expected,'board_height':round(geometry_check(page),1)})
   assert snapshot(page)==initial
   page.locator('#btn-game-story').focus();page.keyboard.press('Enter')
   assert page.evaluate('document.activeElement.id')=='btn-close-game-story'
   page.keyboard.press('Escape')
   assert page.evaluate('document.activeElement.id')=='btn-game-story'
   page.locator('#btn-leaderboard').click()
   assert page.evaluate('document.activeElement.id')=='btn-close-leaderboard'
   page.keyboard.press('Escape')
   assert page.evaluate('document.activeElement.id')=='btn-leaderboard'
   page.set_viewport_size({'width':320,'height':480})
   if port==8787:page.screenshot(path=str(ROOT/f'tests/seo-validation-{locale}.png'))
   assert page.evaluate("!localStorage.getItem('huarong_rod_identity_v1') && !localStorage.getItem('huarong_hd1_outbox_v1')")
   assert page.evaluate('!solverEnabled && !assistedRun && userMovesCount===0')
   assert not any(method=='POST' for method,url in requests),requests
   assert not any('leaderboard-client.js' in url or 'googletagmanager' in url or 'google-analytics' in url for method,url in requests),requests
   assert not errors and not console_errors,(errors,console_errors)
   print(json.dumps({'port':port,'locale':locale,'roundtrip_states':len(observations),'fit':observations,'errors':errors,'console_errors':console_errors,'posts':0,'identity':False,'lazy_solver':True,'consent':'rejected'},ensure_ascii=False),flush=True)
   context.close()
  context=browser.new_context(java_script_enabled=False,locale='en-US',viewport={'width':320,'height':480})
  page=context.new_page();response=page.goto(base,wait_until='load');assert response.status==200
  state=snapshot(page);metadata_check(state,'bg');geometry_check(page)
  assert page.locator('#game-explanation').is_visible()
  assert page.locator('#board > .tile').count()==0
  for asset in ['robots.txt','sitemap.xml','social-preview.png','favicon.png']:
   response=context.request.get(base+asset);assert response.status==200,(asset,response.status)
   if asset=='sitemap.xml':
    root=ElementTree.fromstring(response.text())
    assert root.tag=='{http://www.sitemaps.org/schemas/sitemap/0.9}urlset'
    assert [el.text for el in root.iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]==[ORIGIN]
   if asset.endswith('.png'):assert response.headers['content-type'].startswith('image/png')
  print('PASS no-JS Bulgarian description, visible instructions, 320x480 fit, real XML parse and four asset GETs on',port,flush=True)
  context.close()
 browser.close()
print('PASS 72 language/viewport states, four startup/consent contexts, two no-JS contexts; no live requests',flush=True)
