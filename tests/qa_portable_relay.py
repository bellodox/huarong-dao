"""Real workerd versus Node: the same root distribution, deterministic public fixtures only."""
import copy,json,subprocess
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[1]
# Invoke the actual runtime: Windows launcher shims can silently drop multiline --eval programs.
NODE=subprocess.check_output(['node','-p','process.execPath'],cwd=ROOT,text=True,timeout=10).strip()
assert Path(NODE).is_file(),NODE
load=lambda name:json.loads((ROOT/'tests/fixtures'/f'{name}.json').read_text(encoding='utf-8'))
compact=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':'))
vectors,transactions,history,paths=map(load,['receipt','transactions','history','paths'])

def node(probes):
 code="""import {relayProbe} from './tests/relay-probe.js';
 globalThis.fetch=()=>{throw Error('unexpected_network');};
 let text='';for await(const chunk of process.stdin)text+=chunk;
 console.log(JSON.stringify(JSON.parse(text).map(relayProbe)));"""
 result=subprocess.run([NODE,'--input-type=module','--eval',code],cwd=ROOT,input=compact(probes),capture_output=True,text=True,encoding='utf-8',timeout=30)
 assert result.returncode==0,(result.returncode,result.stdout,result.stderr)
 assert not result.stderr,result.stderr
 assert result.stdout,'Node returned no parity evidence'
 return json.loads(result.stdout)

unsigned={key:value for key,value in vectors['playerClaim'].items() if key!='s'}
signing=[{'kind':'signatures','unsigned':unsigned}]
for path in paths:
 signing.append({'kind':'signatures','unsigned':{'p':'hd1','w':2900,'l':path['l'],'b':path['b'],'n':'Parity','m':path['m']}})
signing.append({'kind':'signatures','unsigned':{**unsigned,'m':'A'}})
signed=node(signing)
assert signed[0]['player']==compact(vectors['playerClaim'])
assert signed[0]['receipt']==compact(vectors['receipt'])
probes=signing+[
 {'kind':'verify','text':value['player']} for value in signed
]+[
 {'kind':'verify','text':compact(vectors['receipt']),'appKey':transactions['appKey']},
 {'kind':'verify','text':compact(vectors['receipt']),'appKey':transactions['markerKey']},
 {'kind':'verify','text':compact(vectors['playerClaim'])+' '},
 {'kind':'verify','text':compact({**vectors['playerClaim'],'p':'hd2'})},
 {'kind':'verify','text':compact({**vectors['playerClaim'],'s':'A'*87})},
 {'kind':'transaction','prepared':transactions['prepared'],'receipt':vectors['longReceipt'],'appKey':transactions['appKey'],'markerKey':transactions['markerKey']},
 {'kind':'transaction','prepared':transactions['updatePrepared'],'receipt':vectors['receipt'],'appKey':transactions['appKey'],'markerKey':transactions['markerKey']}
]
variants=[history,{**history,'headers':history['headers'][:7]},{**history,'transactions':history['transactions'][:1]},{**history,'complete':False}]
crossed=copy.deepcopy(history)
for header in crossed['headers']:header['time']+=604800
variants.append(crossed)
for variant in variants:
 probes.append({'kind':'reconstruct','text':compact(variant),'bootstrap':compact(history['bootstrap'])})
expected=node(probes)
response=requests.post('http://127.0.0.1:8788/__fixture/portable',json=probes,timeout=60)
response.raise_for_status()
actual=response.json()
assert actual==expected,'Worker/Node distribution parity mismatch'
accepted=expected[len(signing):len(signing)+len(signed)]
assert accepted[0]['moves']==116 and accepted[0]['points']==1160
assert sum(result.get('ok') is True for result in accepted)==12 # vector plus eleven ranked
assert sum(result.get('code')=='practice_layout' for result in accepted)==3
assert accepted[-1]['code']=='invalid_replay'
transaction_results=[result for result in expected if 'preimages' in result]
assert [result['raw'] for result in transaction_results]==[transactions['register']['raw'],transactions['update']['raw']]
assert transactions['updatePrepared']['inputs'][0]['script'] in transaction_results[1]['preimages'][0]
rebuilds=expected[-5:]
assert len(rebuilds[0]['receipts'])==2 and rebuilds[0]['rankings'][0]['points']==1160
assert len(rebuilds[1]['receipts'])==1 and len(rebuilds[1]['pending'])==1
assert rebuilds[2]['rankings'][0]['bests']['wings']['moves']==1536
assert rebuilds[3]['code']=='canonical_history_required'
assert all(row['epoch']==2901 for row in rebuilds[4]['receipts'])
print(f'PASS {len(probes)} Node/workerd parity probes: all 14 layouts, accepted/rejected claims, canonical signatures/IDs/bytes/scores, register/update full preimages/digests/raw txids, reconstruction/finalization/reorg/week crossing; imported CLI remained inert')
