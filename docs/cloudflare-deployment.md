# Cloudflare deployment guide — disabled by design

Operator runbook, 2026-10-29. Commands below are **instructions for later operator execution**, not evidence of deployment or permission to deploy. Current scope, supplied evidence and final review status are centralized in the [execution handoff](../tests/release-evidence.md#github-workers-builds-current-scope). No cloud login, account probe, deploy, funding, secret read, commit or push was performed for this guide.

## 1. Choose the readiness tier

| Tier | What the current implementation supports | Boundary |
| --- | --- | --- |
| Disabled/static | Locally packaged Worker plus game assets; local play and disabled public API | No wallet, Supabase or app WIF needed. Remote deployment remains an operator action, not a verified result. |
| Optional read-only | Explicitly configured server-only Supabase reads after both migrations | Public submission still disabled; hosted database/PostgREST behavior unverified. Database rows are not chain score proof. |
| Restricted funded E1 | A future separately authorized live feasibility experiment | Blocked on secure limited funding, network/name/bootstrap, live adapter and authenticated complete history/headers, spend budget and hosted validation. No deploy flag supplies these. |
| Public issuance | Not enabled by this implementation | No enablement switch or publication CLI. Human numerical versioned ranked ceilings and E1/public-use gates remain unresolved. |

The [production adapter](../leaderboard/relay-entry.js:72) always supplies availability false. Adding credentials, an HMAC key or a legacy issuer binding does not enable signing. Never deploy the [loopback fixture](../tests/runtime-worker.js), its configuration or publicly known test keys. Never reuse an exposed issuer key. The [frozen decision delta](Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) is not rewritten by this runbook.

## 2. Primary workflow: GitHub push to Workers Builds

The existing GitHub remote is **bellodox/huarong-dao**. Normal deployment is an authorized operator's push to the connected production branch, followed by Cloudflare Workers Builds. No GitHub Actions workflow, Cloudflare Pages project or local Wrangler login/deploy is needed. This guide does not authorize agents to commit, push or deploy.

Open **Workers & Pages → huarong-rod-experiment → Settings → Build**:

| Dashboard setting | Value |
| --- | --- |
| Connected repository | bellodox/huarong-dao |
| Production branch | leaderboard — current intended branch; choose the branch the operator actually pushes for production, not an assumed main |
| Root directory | / |
| Build command | npm ci --include=dev --no-audit --no-fund && npm run build && npm test |
| Deploy command | npm run deploy |
| Preview/non-production builds | Disabled for this production-only scope |

Configure these **build variables**, separately from Worker runtime secrets:

| Build variable | Value |
| --- | --- |
| SKIP_DEPENDENCY_INSTALL | 1 |
| NODE_VERSION | 24.14.1 |
| WRANGLER_SEND_METRICS | false |
| CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV | false |

Installation is explicit in the build command; there is no separate install-command field to configure. Dev dependencies are required for builds/tests. The Node override must match [the version file](../.nvmrc); override any conflicting dashboard setting. The currently documented default image is Ubuntu 24.04 x86_64 with npm 10.9.2. Node 24.14.1 is an explicitly supported override, not a claim that this exact version is preinstalled. No hosted Ubuntu build was run here.

The [manifest build](../package.json:7) regenerates both the [relay](../relay.js) and [browser signing bundle](../public/leaderboard-client.js), then checks relay bytes. Tests check the relay again. The [lockfile](../package-lock.json) pins Wrangler **4.155.0**; [LF rules](../.gitattributes) preserve reproducible distribution bytes. Wrangler's [custom build](../wrangler.jsonc:5) rejects stale relay output rather than silently repairing it during deployment.

The [configured Worker name](../wrangler.jsonc:2), **huarong-rod-experiment**, must match the connected Worker. Configuration selects the [thin Worker](../worker.js), public assets and Worker-first root/index/API routes. This is Workers with assets: no dist/output-directory dashboard field is needed. Never substitute the test fixture or bypass custom builds. Do not change a non-production version-upload command into a production deploy; preview builds require separate isolation review if later wanted.

The operator must confirm GitHub App repository access and build token/account permissions for the intended Worker; these external settings were not inspected here. Record a prior safe deployment/version ID, routes/domains and binding names securely, never secret values. Review account usage/billing limits without assuming spending authorization.

Build variables do **not sanitize existing remote runtime bindings**. Review binding names through Worker settings and remove obsolete issuer credentials. For disabled/static mode leave optional reads disabled and remove unnecessary read credentials. No wallet, app WIF, Supabase or HMAC key is required. Do not use keep-vars to preserve unknown configuration. Deployment credentials never enable issuance.

After saving settings, the authorized operator pushes the intended production branch and inspects the Cloudflare build log. Install, build and tests must succeed before deployment. Record the actual commit, deployed version and reported URL, then perform section 6 checks. A local simulation is not proof that the GitHub integration, hosted build or deployment succeeded.

## 3. Secondary: local checks and dry-run in Windows CMD

For troubleshooting, run from the repository root with Node 24.14.1 and the locked local tools. Package installation is not a Cloudflare login. No lint/typecheck command or checked-in CI workflow exists.

```bat
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
```

Stop on a nonzero exit before continuing. The aggregate build regenerates both distributions; do not rewrite generated bundles manually.

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

## 4. Secondary: manual CLI recovery only

Normal push-triggered Builds needs no local authentication. Manual remote CLI operations are optional recovery tools for an already authorized operator with the intended account/Worker verified, not normal setup prerequisites. This guide adds no login requirement. After local checks, with the task-owned empty env-file still present, a separately authorized manual deployment uses:

```bat
npm run deploy -- --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
```

Do not run this in parallel with an automatic production build. Use the production configuration exactly; do not pass the test fixture entry, bypass custom builds or add an imagined enablement flag. Record the actual deployed version and URL returned by Cloudflare. For a first release, use the intended Workers endpoint; add a custom domain only as a separately approved routing change. Do not invent a target URL or assume an existing deployment is known-good.

Deployments retain existing secrets, so an empty env-file does **not** sanitize remote bindings. On a reused Worker, inspect binding **names** securely through the dashboard and remove obsolete issuer credentials. For disabled/static mode ensure optional reads are not enabled, and remove unnecessary read credentials. Do not use keep-vars to preserve unknown configuration. No app WIF, rate HMAC or Supabase secret is needed for this mode.

## 5. Optional server-only Supabase reads

This is a separate operator decision, not a prerequisite for the game. Hosted setup/testing has not been completed here. Configure these as **Worker runtime bindings/secrets**, separately from Build variables, through the authorized dashboard; the CLI prompts below are optional equivalents for authorized recovery.

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

Workers Builds references verified by the prior code executor on **2026-10-29**: [configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) and [branch builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/). These rolling official sources support dashboard guidance, not a hosted execution claim.

Official Cloudflare references consulted **2026-10-29**: [Workers commands: deploy, secrets and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [general commands: login](https://developers.cloudflare.com/workers/wrangler/commands/general/) and [command index](https://developers.cloudflare.com/workers/wrangler/commands/). Their Markdown endpoints were retrieved successfully; the HTML command index returned 403 in this environment. These are rolling official references, not version-pinned documentation. Command support was cross-checked against the repository-pinned Wrangler 4.155.0 local help for deploy, login, secret put/delete and rollback; only help was executed, not those remote operations. Do not upgrade dependencies merely to follow a rolling example.

Before restricted funded E1: secure limited-funded signing input, approved network/name and pinned bootstrap, authenticated prevouts/history/header ancestry, verified live transport/fees/name minimum, explicit fee/locked-output spend envelope, durable hosted operational state and independent raw replay. A historical 1 ROD ceiling is **not** a spending authorization. Before public use: resolve/publish numerical versioned ranked ceilings consistently, pass live E1 and hosted validation, complete parent-owned independent testing/security/Code Reviewer gates and obtain separate public-use authorization. No local mock, packaging result or documentation approval satisfies those gates.
