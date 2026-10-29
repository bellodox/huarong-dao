"""All ranked layouts: checked-in browser bundle to real local workerd and SQL/signing."""
import json
from pathlib import Path
import requests
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
paths=json.loads((ROOT/'tests/fixtures/paths.json').read_text())
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page();errors=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.route('https://**',lambda route:route.abort())
 page.goto('http://127.0.0.1:8788/',wait_until='domcontentloaded')
 ranked=0;practice=0
 for path in paths:
  requests.post('http://127.0.0.1:8788/__fixture/reset',timeout=30).raise_for_status()
  result=page.evaluate('''async evidence=>{
   const module=await import('/leaderboard-client.js');
   let signed;
   try {signed=module.createSignedClaim(evidence,'AllLayouts',2900,{consented:()=>true});}
   catch(error){return {error:error.message};}
   const response=await fetch('/api/score',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':signed.id},body:signed.bytes});
   return {status:response.status,body:await response.json(),signed};
  }''',path)
  if path['practice']:
   assert result=={'error':'practice_layout'},result
   practice+=1;continue
  assert result['status']==202,(path['l'],result)
  assert result['body']['status']=='broadcast_unknown',result
  assert result['body']['derived_moves']==path['optimum'],result
  state=requests.get('http://127.0.0.1:8788/__fixture/state',timeout=30).json()
  assert len(state['claims'])==1 and state['coordinator']['generation']==1
  claim=state['claims'][0];receipt=json.loads(claim['receipt'])
  assert claim['bytes']==result['signed']['bytes'] and claim['id']==result['signed']['id']
  assert claim['raw'] and claim['attempts']==1 and receipt['l']==path['l']
  assert receipt['m']==path['m'] and len(receipt['s'])==len(receipt['a'])==87
  ranked+=1
 assert ranked==11 and practice==3 and not errors,errors
 browser.close()
print('PASS checked-in browser bundle + real workerd + SQL: all 11 ranked layouts signed, verified, app-signed, persisted before ambiguous broadcast; 3 practice excluded; 0 page errors')
