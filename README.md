# Cloudflare Workers redirect compatibility fix (Huarong Dao)

The deployed `/probe` returned `TypeError: Invalid redirect value` because Cloudflare Workers does not implement `fetch(...,{redirect:'error'})`. This change switches to the supported `redirect:'manual'` mode and explicitly rejects all HTTP 300-399 responses without following them.

## Install

Copy these files over the same paths in the `leaderboard` branch:

- `leaderboard/provider.js` (publisher transport fix)
- `tests/rod-transport-probe.worker.js` (runtime diagnostic fix)
- `tests/rod-transport-probe.test.js` (updated probe regression tests)
- `tests/rod-redirect-compat.test.js` (new provider transport regression tests)

The files are based on the repository's `leaderboard` branch at commit `dd6d297a03bf5a5b93893f0b5c10094ccef89037` as inspected on 2026-11-02. No change is required to `worker.js`, `wrangler.jsonc`, `publisher.js`, the ROD API URL, Supabase, or the signing procedure.

## Verify/deploy

`npm ci --include=dev --no-audit --no-fund && npm run build && npm test`

The existing deployment command can then deploy the rebuilt `relay.js`; `npm run build` regenerates that file. The new tests are included automatically by `npm test`.

Once deployed, run `curl -sS 'https://huarong-dao.spacexpanseorg.workers.dev/probe'` (do not add query parameters).

Expected if fixed: `fetch.ok: true`, `fetch.connected: true`, `fetch.http_status: 200`, `fetch.chain: "main"`. The scheduled publisher will then progress past its first `/info` call, although other independent problems may remain.

## Security

Redirects are never followed. The publisher rejects 300-399 with stable `provider_http_error` and sanitized `{category:'http_error',status,path}`; it does not log redirect destinations. The probe uses a fixed, read-only endpoint and returns no credentials. GET retries for 429/5xx remain unchanged; broadcasts remain non-retrying.

## Validation in this package

`node --check` passed for changed JavaScript files. The 12 focused tests in the two supplied test files passed locally on Node 22. The full repository suite and the deployed Cloudflare Worker were not run here.
