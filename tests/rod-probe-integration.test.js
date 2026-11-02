/** Guard the temporary /probe runtime route against accidental asset interception. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);

test('production Worker forwards only /probe to fixed-target diagnostic', () => {
  const source=readFileSync(new URL('worker.js',root),'utf8');
  const config=JSON.parse(readFileSync(new URL('wrangler.jsonc',root),'utf8'));
  assert(config.assets.run_worker_first.includes('/probe'));
  assert.match(source,/if\(pathname==='\/probe'\)return rodProbe\.fetch\(request\)/);
  assert.match(source,/if\(pathname\.startsWith\('\/api\/'\)\)return handleRelayRequest\(request,env,ctx\)/);
  assert.match(source,/ctx\.waitUntil\(handleScheduled\(env\)\)/);
});
