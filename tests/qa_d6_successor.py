"""Real workerd + SQL D6 sequencing; public non-funded fixtures, no live chain."""
import json,subprocess
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE='http://127.0.0.1:8788'
def control(action,**extra):
 response=requests.post(BASE+'/__fixture/d6',json={'action':action,**extra},timeout=30)
 response.raise_for_status();return response.json()
def state():
 response=requests.get(BASE+'/__fixture/state',timeout=30);response.raise_for_status();return response.json()
node=subprocess.check_output(['node','-p','process.execPath'],text=True).strip()
program="""import {signPlayer,canonical,receiptId,hexToBytes} from './relay.js';
import {readFileSync} from 'node:fs';
const path=JSON.parse(readFileSync('tests/fixtures/paths.json')).find(row=>row.l==='wings');
console.log(JSON.stringify([4,5,6].map(n=>{const claim=signPlayer({p:'hd1',w:2900,l:path.l,b:path.b,n:'D6Player'+n,m:path.m},hexToBytes(n.toString(16).padStart(64,'0')));return {id:receiptId(claim),bytes:canonical(claim,7)};})));"""
claims=json.loads(subprocess.check_output([node,'--input-type=module','--eval',program],cwd=ROOT,text=True))
def submit(claim):
 response=requests.post(BASE+'/api/score',headers={'Origin':BASE,'Content-Type':'application/json','Idempotency-Key':claim['id']},data=claim['bytes'],timeout=30)
 assert response.status_code==202,(response.status_code,response.text)
 return response.json()
started=control('start');assert not started['coordinator']['paused'] and not started['claims']
assert len(started['coordinator']['snapshot']['pending'])==2
first=submit(claims[0]);assert first['status']=='broadcast_unknown'
second=submit(claims[1]);assert second['status']=='queued'
assert state()['coordinator']['generation']==1
included=control('include',id=claims[0]['id'])
predecessor=next(row for row in included['claims'] if row['id']==claims[0]['id'])
assert predecessor['state']=='included' and predecessor['confirmations']==1 and included['coordinator']['active'] is None
assert not any(row['txid']==predecessor['txid'] for row in included['coordinator']['snapshot']['receipts'])
assert submit(claims[0])['status']=='included'
second=submit(claims[1]);assert second['status']=='broadcast_unknown'
third=submit(claims[2]);assert third['status']=='queued'
current=state();assert current['coordinator']['generation']==2
assert next(row for row in current['claims'] if row['id']==claims[0]['id'])['raw']==predecessor['raw']
assert len([row for row in current['claims'] if row['state']=='broadcast_unknown'])==1
public=requests.get(BASE+'/api/leaderboard',timeout=30).json()
assert not public['rows'] and len(public['pending'])==3 and not public['stale']
# Real browser mutation translation and consented outbox retry must display inclusion without POST.
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for locale,expected in [('en-US','Included in a block'),('bg-BG','Включено в блок')]:
  context=browser.new_context(locale=locale);page=context.new_page();errors=[];posts=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  page.on('request',lambda request:posts.append(request.url) if request.url.endswith('/api/score') else None)
  page.route('https://**',lambda route:route.abort())
  page.goto(BASE+'/',wait_until='domcontentloaded');page.wait_for_function('window.hd1UI&&HUARONG_PUBLIC_ENABLED')
  page.evaluate("""signed=>{nickname='D6Player4';nameLocked=true;allowPublicScores=true;publicNameReady=true;
   localStorage.setItem('huarong_hd1_outbox_v1',JSON.stringify({[signed.id]:{...signed,player:nickname,localId:'fixture',epoch:2900}}));}""",claims[0])
  page.evaluate('hd1UI.sync()');page.wait_for_function('(expected)=>document.getElementById("hd1-status").textContent.includes(expected)',arg=expected)
  assert not posts and not errors,(posts,errors)
  context.close()
 browser.close()
print('PASS D6 real workerd + SQL: zero blocks, one reconciled permits exactly one successor; predecessor immutable/included not ranked; bilingual included status and no browser rebroadcast')
