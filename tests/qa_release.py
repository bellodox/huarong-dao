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
relay=(ROOT/'leaderboard/relay-entry.js').read_text()
assert "from './relay.js'" in worker and 'return handleRelayRequest(request,env,ctx)' in worker
assert 'leaderboard/' not in worker and 'verifyClaim' not in worker and 'SupabaseStorage' not in worker
assert "storage.publicRead('readiness'," in relay and 'readiness?.available===true' in relay
assert 'ctx.waitUntil(handleScheduled(env))' in worker and config['triggers']['crons']==['* * * * *']
assert "crypto.subtle.sign('HMAC'" in relay and 'sha256(' not in relay
assert "storage.publicRead('status'" in relay and 'publicLeaderboard(storage,url.searchParams)' in relay
assert '.replace(' not in worker and 'HUARONG_ISSUER_WIF' not in worker
assert config['build']['command']=='npm run check:relay'
assert (ROOT/'relay.js').is_file()
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
print('PASS offline release boundaries: public routing/five QA paths, runtime readiness-gated publisher, cron, no key substitution, preserved rollback journal; hosted/funded acceptance unverified')
