# Huarong Dao: build-time diagnostics + deployed /probe endpoint

Based on GitHub `leaderboard` HEAD `14ab64cd7fcb932e17e9409e655aae757032f4c0` (2026-11-02).

Copy the five supplied files into the repository root, preserving their paths:

- `worker.js` (complete replacement; preserves existing game API and scheduler)
- `wrangler.jsonc` (complete replacement; adds `/probe` to the `run_worker_first` asset-routing list)
- `tests/rod-transport-probe.worker.js` (new)
- `tests/rod-transport-probe.test.js` (new)
- `tests/rod-network-diagnostics.test.js` (new)

## Build-time check

`npm test` automatically discovers `tests/*.test.js` under the existing `package.json` script. The network test prints exactly one JSON line prefixed `HD1_ROD_NETWORK_DIAGNOSTIC`; it is non-gating for remote network failures. These checks run in the Node build environment, **not** in the deployed Worker isolate.

Ensure Cloudflare Workers Builds actually runs `npm test`. The repository's Wrangler `build.command` alone is `npm run check:relay`, and cannot substitute for the dashboard build command. Recommended dashboard build command:

```
npm ci --include=dev --no-audit --no-fund && npm run build && npm test
```

## Runtime check (after deploying)

Open `https://huarong-dao.spacexpanseorg.workers.dev/probe` and paste the JSON response. The endpoint runs on the actual deployed Cloudflare Worker and tests HTTPS `fetch('/info')`, TCP to port 1234 and TLS to port 1234. It returns the sanitized results; no wallets, database credentials, signing or broadcast.

The `/probe` endpoint is **temporary** and publicly callable. It has a hardcoded destination, strict GET-only route and bounded network operations, but anyone can invoke it repeatedly. Remove its import and route from `worker.js` after diagnosis.

This package does not modify ROD API DNS, Cloudflare bindings, signing, broadcast, fee limits, Supabase schema or recovery state.
