"""Offline release-boundary assertions; not a live deployment/chain acceptance test."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
config=json.loads((ROOT/'wrangler.jsonc').read_text())
assert config['main']=='worker.js'
assert config['assets']['directory']=='./public'
assert '/api/*' in config['assets']['run_worker_first']
for name in ['qa_edge.py','qa_v14.py','qa_dialog_keyboard.py','qa_accessibility.py','qa_deep_independent.py']:
 text=(ROOT/'tests'/name).read_text(encoding='utf-8')
 assert ("'public'/'index.html'" in text or ("parents[1]/'public'" in text and "{ROOT}/index.html" in text)),name
 assert "'docs'/'index.html'" not in text and 'docs/index.html' not in text,name
worker=(ROOT/'worker.js').read_text()
assert 'return handleApi(request,{storage,available:false,rateSecret:env.HD1_RATE_HMAC_KEY})' in worker
assert "crypto.subtle.sign('HMAC'" in worker and 'sha256(' not in worker
assert "storage.publicRead('status'" in worker and 'publicLeaderboard(storage,url.searchParams)' in worker
assert '.replace(' not in worker and 'HUARONG_ISSUER_WIF' not in worker
html=(ROOT/'public/index.html').read_text(encoding='utf-8')
assert 'HUARONG_PUBLIC_ENABLED = false' in html
assert 'beginRunEvidence' in html and 'leaderboard-ui.js' in html
assert (ROOT/'public/leaderboard-client.js').is_file()
assert (ROOT/'supabase/migrations/001_leaderboard.sql').is_file()
rollback=(ROOT/'supabase/001_leaderboard.rollback.sql').read_text()
assert 'paused=true' in rollback and 'revoke execute' in rollback
assert 'hd1_public(text,jsonb)' in rollback and 'hd1_rpc(text,jsonb)' in rollback
assert 'drop table' not in rollback.lower() and 'delete from' not in rollback.lower()
for file in (ROOT/'leaderboard').glob('*.js'):
 assert 'DurableObject' not in file.read_text(),file
print('PASS offline release boundaries: public routing/five QA paths, disabled production issuer, no key substitution, preserved rollback journal, no Durable Object; live E1 and parent reviews remain unverified')
