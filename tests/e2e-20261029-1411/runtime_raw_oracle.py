"""Independently verify fresh loopback Worker output using existing Python oracle.
Known non-funded fixture transaction data only; no live transport or consensus claim.
Run after the ranked Worker suite has finished and before stopping owned runtimes.
"""
import json
import runpy
from pathlib import Path
import requests

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parents[1]
results = json.loads((OUTPUT / 'results.json').read_text())
assert any(row['log'] == 'qa_ranked_worker.log' and row['exit'] == 0 for row in results)
oracle = runpy.run_path(str(ROOT / 'tests/qa_reconstruct.py'))
state_response = requests.get('http://127.0.0.1:8788/__fixture/state', timeout=30)
state_response.raise_for_status()
state = state_response.json()
assert len(state['claims']) == 1 and state['coordinator']['generation'] == 1
claim = state['claims'][0]
assert claim['state'] == 'broadcast_unknown' and claim['attempts'] == 1
transaction = oracle['transaction'](claim['raw'])
assert transaction['id'] == claim['txid']
fixture = json.loads((ROOT / 'tests/fixtures/transactions.json').read_text())
previous = {oracle['transaction'](item['previousRaw'])['id']: oracle['transaction'](item['previousRaw']) for item in fixture['prepared']['inputs']}
key = oracle['key']
for index, (raw_id, output_index, _, _) in enumerate(transaction['inputs']):
    output = previous[raw_id[::-1].hex()]['outputs'][int.from_bytes(output_index, 'little')]
    assert output[1][-25:] == oracle['pay'](key)
    oracle['tx_signature'](transaction, index, output[1], key)
values = []
for amount, script in transaction['outputs']:
    if script[0] not in (0x51, 0x52):
        continue
    reader = oracle['Reader'](script)
    assert reader.num(1) == 0x51
    assert reader.push() == b'g/huarong-lb'
    value = reader.push()
    assert reader.take(2) == b'\x6d\x75' and reader.take(25) == oracle['pay'](key)
    values.append(value)
assert len(values) == 1
assert any(script == oracle['pay'](oracle['marker']) for _, script in transaction['outputs'])
receipt = json.loads(values[0])
assert oracle['canonical'](receipt) == values[0] == claim['receipt'].encode()
app_signature = receipt.pop('a')
assert oracle['recover']('app', receipt, app_signature) == key
assert oracle['canonical'](receipt).decode() == claim['bytes']
player_signature = receipt.pop('s')
player_key = oracle['recover']('player', receipt, player_signature).hex()
assert player_key == claim['player']
path = oracle['paths'][receipt['l']]
assert receipt['b'] == path['b'] and receipt['m'] == path['m']
moves, points = oracle['replay'](receipt, path['optimum'])
assert moves == claim['moves'] and points == claim['points']
public = {'fixture': True, 'live': False, 'claim_id': claim['id'], 'txid': claim['txid'], 'raw': claim['raw'], 'receipt': claim['receipt'], 'layout': receipt['l'], 'moves': moves, 'points': points, 'transaction_bytes': len(claim['raw']) // 2, 'state': claim['state'], 'attempts': claim['attempts'], 'generation': state['coordinator']['generation'], 'independent_input_signatures': len(transaction['inputs']), 'independent_receipt_signatures': 2, 'real_broadcasts': 0, 'real_spend': 0}
(OUTPUT / 'worker-fixture-public.json').write_text(json.dumps(public, indent=2))
print('PASS fresh loopback raw independently verified:', json.dumps({key: value for key, value in public.items() if key not in ('raw', 'receipt')}), flush=True)
