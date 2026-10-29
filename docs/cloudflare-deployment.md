# Cloudflare deployment guide — disabled by design

Operator runbook, 2026-10-29. Commands below are **instructions for later human execution**, not evidence of deployment or permission to deploy. Current measured results, scoped completed independent reviews and remaining gaps are centralized in the [execution handoff](../tests/release-evidence.md#d7d6-current-local-scope). No cloud login, account probe, deploy, funding, secret read, commit or push was performed for this guide.

## 1. Choose the readiness tier

| Tier | What the current implementation supports | Boundary |
| --- | --- | --- |
| Disabled/static | Locally packaged Worker plus game assets; local play and disabled public API | No wallet, Supabase or app WIF needed. Remote deployment remains an operator action, not a verified result. |
| Optional read-only | Explicitly configured server-only Supabase reads after both migrations | Public submission still disabled; hosted database/PostgREST behavior unverified. Database rows are not chain score proof. |
| Restricted funded E1 | A future separately authorized live feasibility experiment | Blocked on secure limited funding, network/name/bootstrap, live adapter and authenticated complete history/headers, spend budget and hosted validation. No deploy flag supplies these. |
| Public issuance | Not enabled by this implementation | No enablement switch or publication CLI. Human numerical versioned ranked ceilings and E1/public-use gates remain unresolved. |

The [production adapter](../leaderboard/relay-entry.js:72) always supplies availability false. Adding credentials, an HMAC key or a legacy issuer binding does not enable signing. Never deploy the [loopback fixture](../tests/runtime-worker.js), its configuration or publicly known test keys. Never reuse an exposed issuer key. The [frozen decision delta](Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) is not rewritten by this runbook.

## 2. Prepare locally in Windows CMD

Run from the repository root with Node 24.2+ (executor exercised 24.14.1) and npm. The [manifest](../package.json) and [lockfile](../package-lock.json) pin Wrangler **4.155.0**. Use the installed local launcher below, not a global/latest package. Package installation can download locked dependencies; it is not a Cloudflare login. No lint, typecheck or CI command exists.

```bat
npm ci
npm run build:relay
npm run check:relay
npm test
```

Stop on a nonzero exit before continuing. Build regenerates the [relay distribution](../relay.js) from [source](../leaderboard/relay-entry.js) and dependencies. Check compares exact bytes; the [Wrangler custom build](../wrangler.jsonc) checks rather than silently repairs a stale artifact. Rebuild the [browser signing bundle](../public/leaderboard-client.js) with the manifest's build:client command only if its source changed. Do not rewrite generated bundles manually.

### Secret-safe local packaging

Use a **new, task-owned** empty file and output directory under tests; if either name exists, choose different names and update every command. Do not overwrite or inspect an existing environment file. These commands deliberately avoid loading restricted secret files. Telemetry and development dotenv auto-loading are disabled; the explicit empty env-file selects the deployment environment input. Start from a shell without inherited application credentials or cloud tokens; empty dotenv input does not clear process environment variables. No authentication/status probe is needed.

```bat
set WRANGLER_SEND_METRICS=false
set CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
type nul > tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd deploy --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp --dry-run --outdir tests\cloudflare-doc-dryrun
```

Expected: local build exits 0, emits a Worker bundle and asset summary, and does not upload. The only declared binding is Cloudflare's assets binding; no fixture route, app key or issuance binding is required. A stale relay must fail the custom build before packaging. Dry-run is **not** hosted acceptance or proof that every future Wrangler invocation is network-isolated. Prior network-denied packaging evidence is attributed in the handoff, not rerun here.

Review output without publishing it if it may contain operational details. Remove only these owned disposable outputs when no longer needed:

```bat
del tests\cloudflare-doc-empty.tmp
rmdir /s /q tests\cloudflare-doc-dryrun
```

Recreate the empty file before subsequent commands that reference it. Keep it until all intended operator commands finish, then clean it. Do not kill unrelated servers or remove other test evidence.

## 3. Create/select the Cloudflare target — later operator action

1. Sign in to the Cloudflare dashboard, select the intended account and confirm its Workers entitlement, usage limits and billing policy. Approve only the intended disabled/static rollout. No paid plan or domain purchase is required by this code, and this guide does not authorize spending.
2. Review the [deployment configuration](../wrangler.jsonc): Worker name is **huarong-rod-experiment**, entry is the [thin Worker](../worker.js), assets are the public directory, and root/index/API paths run Worker-first. There is no named deployment environment or fixture route. Explicitly confirm the target account and whether an existing Worker of that name would be replaced. With multiple accounts, set the intended account ID in authorized configuration or select it when prompted; do not rely on an accidental default.
3. Record any existing deployment/version ID, routes/domains and binding names securely before changing them. Never capture secret values in evidence. A previous version containing exposed-key injection is not a safe rollback target.
4. Authenticate only after separate operator authorization. Recreate the task-owned empty file as above, then use the pinned launcher:

```bat
node_modules\.bin\wrangler.cmd login --env-file tests\cloudflare-doc-empty.tmp
```

Complete the browser OAuth flow for the intended account. This step is external interaction, not a local-play prerequisite. Do not export tokens or copy credentials into the repository. Cloudflare authentication grants no ROD spending or publication authorization.

## 4. Deploy disabled/static mode — later operator action

Run the local checks first. With the empty env-file still present and intended target verified:

```bat
node_modules\.bin\wrangler.cmd deploy --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
```

Use the production configuration exactly; do not pass the test fixture entry, bypass custom builds or add an imagined enablement flag. Record the actual deployed version and URL returned by Cloudflare. For a first release, use the intended Workers endpoint; add a custom domain only as a separately approved routing change. Do not invent a target URL or assume an existing deployment is known-good.

Deployments retain existing secrets, so an empty env-file does **not** sanitize remote bindings. On a reused Worker, inspect binding **names** securely through the dashboard and remove obsolete issuer credentials. For disabled/static mode ensure optional reads are not enabled, and remove unnecessary read credentials. Do not use keep-vars to preserve unknown configuration. No app WIF, rate HMAC or Supabase secret is needed for this mode.

## 5. Optional server-only Supabase reads

This is a separate operator decision, not a prerequisite for the game. Hosted setup/testing has not been completed here.

1. Select an authorized Supabase project. Preserve an appropriate backup and existing journal/outbox; never use a reset or table deletion as migration/retry recovery.
2. In the project's secure SQL editor, apply all of [migration 001](../supabase/migrations/001_leaderboard.sql), then all of [migration 002](../supabase/migrations/002_d6_included_successor.sql) for a fresh database. If 001 is already installed, apply **all of 002 atomically**, including its transaction boundaries; do not cherry-pick function fragments or rerun 001 over existing operational data.
3. Confirm migration success and server-only RPC grants. Migration 002 pauses the coordinator and increments revision, invalidating pre-upgrade observations/leases. It retains claims, ownership, reservations, signing barriers and exact raw transactions/lineage. Fresh **authenticated canonical reconciliation** is required before any future issuance; there is no implemented live reconciliation command to invent here. A paused/stale empty or historical read view is not a healthy live publisher.
4. Configure the three exact server bindings accepted by the [storage selection](../leaderboard/relay-entry.js:72): HD1_READS must be the literal string true, SUPABASE_URL must be the authorized HTTPS project URL, and SUPABASE_SERVICE_KEY must be a server-only service credential. Use Cloudflare's secret prompts below, entering values only at the prompt from an authorized secure source. Do not place them on command lines, in browser bundles, SQL records, logs or documentation; do not read restricted local files.

```bat
node_modules\.bin\wrangler.cmd secret put SUPABASE_URL --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd secret put SUPABASE_SERVICE_KEY --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd secret put HD1_READS --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
```

Set HD1_READS last, after both migrations and other bindings. Secret operations are remote changes and may create/deploy a new version; perform only under the same operator authorization and record resulting version IDs. A service credential has elevated access: keeping it server-only does not make it a limited anonymous key. No app WIF is needed. Public read responses are whitelisted/bounded; GET/status never signs, reconciles or broadcasts. Application availability remains false even when rows can be read.

D6 separates **included** (1–5 canonical confirmations) from **finalized** (6+) and weekly close (12). One canonical confirmation **plus lineage reconciliation**, not a mempool acknowledgment, allows a successor while preserving at most one globally unconfirmed app operation. Included predecessors never re-sign/rebroadcast. Reorged/conflicted/ambiguous state fails closed; do not manually clear reservations or signing barriers to resume.

## 6. Verify the actual deployed endpoint

Substitute the URL reported by deployment into the local CMD variable; never use a guessed host. The following commands make real HTTP requests and are later operator actions:

```bat
set HD1_DEPLOYED_URL=https://YOUR-REPORTED-WORKER-HOST
curl.exe -i "%HD1_DEPLOYED_URL%/"
curl.exe -i "%HD1_DEPLOYED_URL%/api/leaderboard"
curl.exe -i -X POST "%HD1_DEPLOYED_URL%/api/score" -H "Origin: %HD1_DEPLOYED_URL%" -H "Content-Type: application/json" --data "{}"
```

- Root serves the game; verify Training startup, Bulgarian/English switching and walletless viewing in a browser. Viewing must not create identity or load signing on its own.
- Disabled/static leaderboard returns HTTP 200 with available false, code issuance_disabled, empty rows/pending, stale true, rewards_enabled false and assurance replayed. With valid optional reads it may return database-derived rows/pending, still available false; a backend failure is a 503, not a passing empty-board check.
- Same-origin score POST returns HTTP **503**, code issuance_disabled and retryable false. A cross-origin rejection is not a substitute for this same-origin check. If any issuance is advertised, stop and investigate the actual deployed entry/configuration.
- Submission status without read configuration returns 503 issuance_disabled; configured reads return a whitelisted status or 404. Do not expect GET to advance publication. Check browser network/console without publishing credentials or personal run evidence.

## 7. Portable CLI is not deployment or publication

The [same artifact](../relay.js) can be copied alone outside the project and run with Node 24.2+, without a listener or project packages. Examples below use operator-supplied evidence filenames, not repository fixtures or live transport adapters:

```bat
node relay.js --help
node relay.js verify canonical-claim.json
node relay.js verify canonical-receipt.json TRUSTED_COMPRESSED_APP_PUBLIC_KEY
type canonical-claim.json | node relay.js verify -
node relay.js reconstruct authenticated-history.json pinned-bootstrap.json
type authenticated-history.json | node relay.js reconstruct - pinned-bootstrap.json
node relay.js status RECEIPT_ID
```

Claim verification accepts no issuer key; receipt verification requires a separately trusted compressed app public key. Verify bounds input to 8,192 bytes. Reconstruction accepts history up to 16 MiB and a bootstrap file up to 8,192 bytes; only history may use stdin. The caller must authenticate complete canonical history/headers and pin bootstrap independently: JSON metadata/CLI success is not live consensus proof. Status is **not offline**: it requires inherited HD1_READS=true, SUPABASE_URL and SUPABASE_SERVICE_KEY through an authorized secure environment. The CLI loads no dotenv files and emits one JSON result; failure exits nonzero. It has no publication/signing command and no packaged executable distribution.

## 8. Rollback and stop conditions

1. Keep production issuance disabled. Disable optional reads first by deleting HD1_READS through the authorized dashboard or the pinned secret-delete command, then remove unneeded read credentials securely. This cuts application reads; it does not erase chain data.
2. If a prior **safe** Worker version exists, use its recorded ID for Cloudflare rollback. Never roll back to exposed-key injection, the test fixture or code lacking required SQL compatibility. For a first deployment without a safe prior version, remove the public route/domain or disable the Worker through the dashboard instead. Do not invent a rollback ID.

```bat
node_modules\.bin\wrangler.cmd secret delete HD1_READS --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd rollback SAFE_RECORDED_VERSION_ID --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
```

3. Review routes/domains and bindings separately after rollback; do not assume a code rollback reverses secret or database changes. Re-run the disabled API checks on the actual endpoint.
4. Where database shutdown is required, apply the [disable-only SQL rollback](../supabase/001_leaderboard.rollback.sql) through the authorized SQL editor. It pauses/revokes RPC execution and **retains** journals, claims, exact raw outbox and reservations. It is not a downgrade that removes migration 002. Reads may then fail closed. Do not delete durable state or reset ambiguous signing; code rollback cannot undo broadcasts. Any future recovery requires authenticated chain/name/input reconciliation and compatible reviewed code.
5. Remove only owned temporary files/output, close the dedicated shell and retain non-secret deployment/version/check evidence. No need to launch or stop local fixtures for this runbook.

## 9. References and remaining gates

Official Cloudflare references consulted **2026-10-29**: [Workers commands: deploy, secrets and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [general commands: login](https://developers.cloudflare.com/workers/wrangler/commands/general/) and [command index](https://developers.cloudflare.com/workers/wrangler/commands/). Their Markdown endpoints were retrieved successfully; the HTML command index returned 403 in this environment. These are rolling official references, not version-pinned documentation. Command support was cross-checked against the repository-pinned Wrangler 4.155.0 local help for deploy, login, secret put/delete and rollback; only help was executed, not those remote operations. Do not upgrade dependencies merely to follow a rolling example.

Before restricted funded E1: secure limited-funded signing input, approved network/name and pinned bootstrap, authenticated prevouts/history/header ancestry, verified live transport/fees/name minimum, explicit fee/locked-output spend envelope, durable hosted operational state and independent raw replay. A historical 1 ROD ceiling is **not** a spending authorization. Before public use: resolve/publish numerical versioned ranked ceilings consistently, pass live E1 and hosted validation, complete parent-owned independent testing/security/Code Reviewer gates and obtain separate public-use authorization. No local mock, packaging result or documentation approval satisfies those gates.
