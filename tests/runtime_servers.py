"""Own only these loopback fixture processes; save PIDs/logs and never blindly duplicate."""
import json,os,subprocess,sys,time,socket
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[1]
STATE=ROOT/'tests/runtime-processes.json'
def port_open(port):
 with socket.socket() as connection:
  connection.settimeout(.2);return connection.connect_ex(('127.0.0.1',port))==0
if '--stop' in sys.argv:
 if STATE.exists():
  for process in reversed(json.loads(STATE.read_text())):
   result=subprocess.run(['taskkill','/PID',str(process['pid']),'/T','/F'],capture_output=True,text=True)
   print('stop owned PID',process['pid'],'exit',result.returncode)
  STATE.unlink()
 sys.exit(0)
if STATE.exists():raise SystemExit('Existing process evidence found; inspect/stop before restarting')
if any(port_open(port) for port in [8787,8788,8790]):raise SystemExit('Required port occupied; no unrelated process stopped')
env={**os.environ,'WRANGLER_SEND_METRICS':'false','CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV':'false'}
commands=[['node','tests/database-fixture.js'],
 ['node','node_modules/wrangler/bin/wrangler.js','dev','--local','--ip','127.0.0.1','--port','8787','--inspector-port','9230','--persist-to','tests/.runtime-prod'],
 ['node','node_modules/wrangler/bin/wrangler.js','dev','--local','--ip','127.0.0.1','--port','8788','--inspector-port','9231','--config','tests/wrangler.local.jsonc','--persist-to','tests/.runtime-fixture']]
processes=[]
try:
 for index,command in enumerate(commands):
  log=open(ROOT/f'tests/runtime-{index}.log','w',encoding='utf-8')
  process=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
  log.close();processes.append({'pid':process.pid,'command':command});STATE.write_text(json.dumps(processes,indent=2))
 for _ in range(120):
  if all(port_open(port) for port in [8787,8788,8790]):break
  time.sleep(1)
 else:raise RuntimeError('Readiness timeout; inspect saved logs/PIDs before retry')
 vector=requests.get('http://127.0.0.1:8788/__fixture/vector',timeout=30);vector.raise_for_status()
 assert vector.json()['matches'],vector.text
 disabled=requests.get('http://127.0.0.1:8787/api/leaderboard',timeout=30);disabled.raise_for_status()
 assert disabled.json()['available'] is False
 root=requests.get('http://127.0.0.1:8787/',timeout=30);root.raise_for_status()
 assert 'beginRunEvidence' in root.text and 'HUARONG_PUBLIC_ENABLED = false' in root.text
 print('PASS real workerd player/app vectors, disabled production entry and public asset routing')
 print(json.dumps(vector.json(),indent=2));print('Owned loopback processes remain for browser inspection; stop using this utility --stop')
except Exception:
 print('Startup incomplete; saved process evidence retained for diagnosis/cleanup',file=sys.stderr)
 raise
