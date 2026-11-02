# Huarong Dao /probe: all publisher endpoints

Based on `bellodox/huarong-dao`, branch `leaderboard`, HEAD `a462741725cadd56527e9329c10549eb1477d1cf` (2026-11-02).

The `/probe` endpoint now checks all **seven read-only routes actually used** by the publisher, plus the original TCP/TLS checks. The generated publisher `relay.js` is unchanged by the probe itself. The existing `worker.js` already forwards `/probe` to `tests/rod-transport-probe.worker.js`; no worker.js modification is necessary.

## Endpoint coverage

| Key | Target | Purpose |
| --- | --- | --- |
| info | `GET /info` | Mainnet and tip (original probe) |
| genesis | `GET /hash/0` | Verify genesis availability |
| range | `GET /range/<current_info_height>?offset=1` | Exercise block/header route |
| history | `GET /history/RFoscLnDa1fuff9exRhy4SkeKzTet1Yxpc?offset=0` | Marker address history, **not public key** |
| unspent | `GET /unspent/RCdhuRDQkwM5aYo4zTCWWk6KQEdFGQByu6` | App wallet UTXOs |
| transaction | `GET /transaction/439112cbfdcec5301cd3302eab22749186382a388b412405966181953e95348c` | Known confirmed transaction details |
| mempool | `GET /mempool` | Actual relay-fee source; `/fee` is not used for publication |
| broadcast | `POST /broadcast` | **Never requested**; reported as `skipped` because mutating |

The addresses and txid are public, confirmed Huarong Dao test identities from operator observations in the conversation. They are intentionally **pinned**, not derived from the WIF or SQL; **if the configured app/marker keys change, update these public probe constants** before interpreting results. Public probes do not prove that the identities match current secret bindings. The results explicitly state `pinned_public_deployment_addresses_not_runtime_key_verification`.

## JSON response

Original `fetch`, `tcp`, `tls`, `interpretation` and `note` fields remain. New fields:

- `endpoints`: each read route's `ok`, path, elapsed time, HTTP status, response shape, bounded schema summary and optional sanitized `api_error_kind`/`api_error_code`.
- `endpoints.broadcast`: `tested:false`, `skipped:true`, explanatory reason; no write is sent.
- `publisher_reads`: summary of seven independently checked read paths; false if even one fails.
- `public_identity`: fixed public addresses used in the test.

For errors, the probe separates `electrumx_error` from `address_rejected`, HTTP redirects, invalid envelopes, responses over **4 MB** and transport/TLS errors. It never returns raw transactions, transaction hex, WIF, provider response bodies, Supabase data, or arbitrary destinations. The API responses are bounded to the same 4 MB ceiling as the publisher. Tests use mocked responses; **live Cloudflare behavior remains to be verified after deployment.**

The check is observational, not a complete cryptographic validation or a guarantee that a subsequent publisher request will succeed. `/probe` is a public route; the expanded endpoint set adds read requests, so leave it enabled only as long as diagnostics are needed or apply suitable rate limiting.

## Install

From the root of your local `leaderboard` checkout:

**If the previous ElectrumX resilience patch is already applied:**

```sh
git apply --check /path/to/huarong-probe-only.patch
git apply /path/to/huarong-probe-only.patch
node --test tests/rod-transport-probe.test.js
```

**If the previous patch was NOT applied:**

```sh
git apply --check /path/to/huarong-full-probe-and-resilience.patch
git apply /path/to/huarong-full-probe-and-resilience.patch
npm ci --include=dev
npm run build
npm test
```

Both patches were tested against the original Git blob SHA baseline for these paths. Alternatively, the ZIP contains complete modified files for a manually checked replacement. Do not apply both patches. Do not deploy without reviewing the diff and running the project tests. `npm run build` is mandatory when the publisher source changes because it regenerates `relay.js`.

To view, open `https://huarong-dao.spacexpanseorg.workers.dev/probe` after deployment. The request remains `GET /probe` with no query parameters; POST and arbitrary URL queries are still rejected. No live deployment or ROD broadcast was performed.

## Verification performed

- All **13** old+new `rod-transport-probe.test.js` tests pass locally (Node 22).
- `node --check` passes for the modified probe and tests.
- `git apply --check` and byte comparison pass for both patch variants against the inspected original source.
- Full repository publisher integration test suite not executed in this runtime (no installed npm packages).
