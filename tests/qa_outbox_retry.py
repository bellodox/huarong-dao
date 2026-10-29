"""Real-browser exact signed outbox recovery, including newer same-layout weekly evidence."""
import json
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
vectors=json.loads((ROOT/'tests/fixtures/receipt.json').read_text())
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for outcome in ['offline','ambiguous']:
  requests.post('http://127.0.0.1:8788/__fixture/reset',timeout=30).raise_for_status()
  context=browser.new_context(locale='en-US')
  page=context.new_page();errors=[];posts=[];phase={'value':'initial'}
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.route('https://**',lambda route:route.abort())
  page.route('**/api/leaderboard*',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'available':True,'epoch':2900,'rows':[],'pending':[],'stale':False})))
  def status(route):
   if phase['value']=='withdraw':page.evaluate('setPublicScoreConsent(false)')
   route.fulfill(status=404 if phase['value']=='initial' else 200,content_type='application/json',body=json.dumps({'status':'broadcast_unknown'}))
  def post(route):
   posts.append({'bytes':route.request.post_data,'id':route.request.headers['idempotency-key']})
   if len(json.loads(route.request.post_data)['m'])==116:
    if outcome=='ambiguous':
     response=route.fetch()
     assert response.status==202
     if phase['value']=='initial':route.abort()  # Actual Worker persisted/sent; browser lost acknowledgement.
     else:route.fulfill(response=response)
    else:route.abort()
   else:route.fulfill(status=202,content_type='application/json',body=json.dumps({'status':'queued'}))
  page.route('**/api/submissions/*',status);page.route('**/api/score',post)
  page.goto('http://127.0.0.1:8788/',wait_until='domcontentloaded')
  page.wait_for_function('window.hd1UI!==undefined && HUARONG_PUBLIC_ENABLED===true')
  page.locator('#btn-game-story-done').click();page.locator('#cookie-reject').click()
  page.evaluate('''claim=>{
   nickname='OutboxPlayer';nameLocked=true;publicNameReady=true;allowPublicScores=true;
   const evidence={p:claim.p,l:claim.l,b:claim.b,n:nickname,m:claim.m,moves:claim.m.length,assisted:false};
   localStorage.setItem(SCORE_STORE_V2_KEY,JSON.stringify({owner:nickname,evidence:{older:evidence}}));
  }''',vectors['playerClaim'])
  page.evaluate('hd1UI.sync()')
  assert len(posts)==1,posts
  original=posts[0];durable=page.evaluate("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'))")
  assert durable[original['id']]['bytes']==original['bytes']
  persisted=None
  if outcome=='ambiguous':
   state=requests.get('http://127.0.0.1:8788/__fixture/state',timeout=30).json()
   persisted=state['claims'][0]
   assert persisted['raw'] and persisted['state']=='broadcast_unknown' and persisted['bytes']==original['bytes']
  page.evaluate('''claim=>{
   const saved=JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY));
   saved.evidence.newer={p:claim.p,l:claim.l,b:claim.b,n:nickname,m:claim.m,moves:claim.m.length,assisted:false};
   localStorage.setItem(SCORE_STORE_V2_KEY,JSON.stringify(saved));
  }''',vectors['longReceipt'])
  assert page.evaluate("hd1UI.candidate('wings').moves")==1536
  phase['value']='retry';posts.clear();page.evaluate('hd1UI.sync()')
  assert len(posts)==2,('older retry and new completion must both be processed',posts)
  assert posts[0]==original,('exact original bytes/ID must survive newer evidence',posts)
  assert len(json.loads(posts[1]['bytes'])['m'])==1536
  after=page.evaluate("JSON.parse(localStorage.getItem('huarong_hd1_outbox_v1'))")
  assert after[original['id']]==durable[original['id']]
  assert len(after)==2
  if persisted:
   state=requests.get('http://127.0.0.1:8788/__fixture/state',timeout=30).json()
   assert state['coordinator']['generation']==1 and len(state['claims'])==1
   assert state['claims'][0]['raw']==persisted['raw'] and state['claims'][0]['txid']==persisted['txid']
  # Revocation while awaiting status must prevent all POSTs, including other outbox rows.
  phase['value']='withdraw';posts.clear();page.evaluate('hd1UI.sync()');assert not posts
  page.evaluate('hd1UI.sync()');assert not posts
  assert not errors,errors
  print('PASS browser outbox',outcome,'116 exact-byte retry + newer 1536 evidence; asynchronous withdrawal blocks all retries; 0 page errors',flush=True)
  context.close()
 browser.close()
