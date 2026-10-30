# Cloudflare deployment guide — experimental publisher

Operator runbook, updated 2026-10-30. Commands below are **instructions for later operator execution**, not evidence of deployment or permission to deploy. Current scope, supplied evidence and final review status are centralized in the [execution handoff](../tests/release-evidence.md#live-publisher-current-scope). No cloud login, account probe, deploy, funding, secret read, commit or push was performed for this guide.

## 1. Choose the readiness tier

| Tier | What the current implementation supports | Boundary |
| --- | --- | --- |
| Disabled/static | Locally packaged Worker plus game assets; local play and disabled public API | No wallet, Supabase or app WIF needed. Remote deployment remains an operator action, not a verified result. |
| Optional read-only | Server-only Supabase reads after migrations 001 → 002 → 003 → 004 | HD1_READS=true and both Supabase bindings; publication can remain disabled. Rows are not chain score proof. |
| Experimental publisher | Implemented production adapter and autonomous one-minute cron | Four runtime bindings, fresh durable readiness and limited funding required; hosted/funded acceptance remains unverified. |
| Public use | Not established by local implementation | Experimental hd2 ceilings are selected/implemented; live E1, hosted validation and separate public-use authorization remain necessary. |

The [production adapter](../leaderboard/relay-entry.js:72) derives availability from validated configuration and fresh SQL readiness. WIF alone is insufficient; the retired issuer binding is ignored. Never deploy the [loopback fixture](../tests/runtime-worker.js), its configuration or publicly known test keys. Never reuse an exposed issuer key. The [execution extension](../tasks/plan.md#14-live-public-leaderboard-execution-extension) selects experimental hd2 policy without rewriting the frozen delta.

## 2. Primary workflow: GitHub push to Workers Builds

The existing GitHub remote is **bellodox/huarong-dao**. Normal deployment is an authorized operator's push to the connected production branch, followed by Cloudflare Workers Builds. No GitHub Actions workflow, Cloudflare Pages project or local Wrangler login/deploy is needed. This guide does not authorize agents to commit, push or deploy.

Open **Workers & Pages → huarong-dao → Settings → Build**:

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

The [manifest build](../package.json:7) regenerates both the [relay](../relay.js) and [browser signing bundle](../public/leaderboard-client.js), then checks relay bytes. Tests check the relay again. The [lockfile](../package-lock.json) pins Wrangler **4.155.0**; [LF rules](../.gitattributes) preserve reproducible distribution bytes. Wrangler's [custom build](../wrangler.jsonc) rejects stale relay output rather than silently repairing it during deployment.

The [configured Worker name](../wrangler.jsonc:2), **huarong-dao**, must match the connected Worker. Configuration selects the [thin Worker](../worker.js), public assets and Worker-first root/index/API routes. This is Workers with assets: no dist/output-directory dashboard field is needed. Never substitute the test fixture or bypass custom builds. Do not change a non-production version-upload command into a production deploy; preview builds require separate isolation review if later wanted.

The operator must confirm GitHub App repository access and build token/account permissions for the intended Worker; these external settings were not inspected here. Record a prior safe deployment/version ID, routes/domains and binding names securely, never secret values. Review account usage/billing limits without assuming spending authorization.

Build variables do **not sanitize existing remote runtime bindings**. Review binding names through Worker settings and remove obsolete issuer credentials. For disabled/static mode set HD1_PUBLISHER=false, leave optional reads disabled and remove unnecessary read credentials. No wallet, app WIF, Supabase or HMAC key is required. Do not use keep-vars to preserve unknown configuration. Deployment credentials alone do not enable issuance; existing application runtime bindings can, so explicitly disable the publisher for static mode.

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

Deployments retain existing secrets, so an empty env-file does **not** sanitize remote bindings. On a reused Worker, inspect binding **names** securely through the dashboard and remove obsolete issuer credentials. For disabled/static mode set HD1_PUBLISHER=false, ensure optional reads are not enabled, and remove unnecessary read credentials. Do not use keep-vars to preserve unknown configuration. No app WIF, rate HMAC or Supabase secret is needed for this mode.

## 5. Runtime configuration and live publisher

This is a separate operator decision, not a prerequisite for the game. Hosted setup/testing has not been completed here. Configure these as **Worker runtime bindings/secrets**, separately from Build variables, through the authorized dashboard; the CLI prompts below are optional equivalents for authorized recovery.

1. Select an authorized Supabase project. Preserve an appropriate backup and existing journal/outbox; never use a reset or table deletion as migration/retry recovery.
2. Apply **only missing migrations**, in order: [001](../supabase/migrations/001_leaderboard.sql) → [002](../supabase/migrations/002_d6_included_successor.sql) → [003](../supabase/migrations/003_live_publisher.sql) → [004](../supabase/migrations/004_finite_publication.sql). Apply each entire file atomically, including transaction boundaries. Existing 001+002 installations apply 003 then 004; existing 001+002+003 installations apply only 004. Never rerun installed migrations or cherry-pick function fragments. Current runtime schema readiness requires 004. Push/build does not apply SQL or runtime secrets.
3. Confirm migration success and server-only RPC grants. Migration 004 alone exposes readiness capability revision 4; HTTP availability and the publisher require it before job acquisition, preparation or signing. A 003-only installation returns schema_upgrade_required even if its older readiness state appears healthy; apply missing 004, not an edited/rerun 003. Migration 002 pauses/increments revision and retains claims, ownership, reservations, signing barriers and exact raw lineage. Migration 003 adds durable acquisition/bootstrap and a 90-second job lease. The publisher performs fresh authenticated provider-anchored reconciliation; a job lease never expires or replaces the signing barrier. A stale/paused historical view is not healthy readiness.
4. Configure the three exact server bindings accepted by the [storage selection](../leaderboard/relay-entry.js:72): HD1_READS must be the literal string true, SUPABASE_URL must be the authorized HTTPS project URL, and SUPABASE_SERVICE_KEY must be a server-only service credential. Use Cloudflare's secret prompts below, entering values only at the prompt from an authorized secure source. Do not place them on command lines, in browser bundles, SQL records, logs or documentation; do not read restricted local files.

```bat
node_modules\.bin\wrangler.cmd secret put SUPABASE_URL --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd secret put SUPABASE_SERVICE_KEY --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
node_modules\.bin\wrangler.cmd secret put HD1_READS --config wrangler.jsonc --env-file tests\cloudflare-doc-empty.tmp
```

For optional read-only mode, set HD1_READS last after all four migrations and both Supabase bindings; no app WIF is needed. HD1_PUBLISHER=false explicitly disables publication even with a key present. Secret operations are remote changes and may deploy a new version; they require operator authorization. A service credential remains elevated despite being server-only. GET/status only performs whitelisted reads: never signing, reconciliation or broadcast.

### Required publication bindings and funding

Configure all four **runtime** bindings through the authorized secure dashboard: ROD_APP_WIF, SUPABASE_URL (HTTPS project URL), SUPABASE_SERVICE_KEY and HD1_RATE_HMAC_KEY (32–256 UTF-8 bytes). These are not build variables. WIF alone is insufficient; valid complete configuration enables publisher startup unless HD1_PUBLISHER is the literal false. Never enter values in documentation, command arguments, browser assets or logs; no restricted secret-file reading is authorized. Remove obsolete issuer credentials; the retired binding is ignored.

Use a fresh, limited-funded **compressed mainnet app WIF**. Fund only its compressed P2PKH app address, derived by the [provider](../leaderboard/provider.js); never fund the separate public-only hash-to-curve marker address. Uncompressed app WIF is incompatible and returns funding_compression_incompatible rather than silently spending a different address. Player legacy WIF compatibility is a separate browser contract.

### Actual defaults, startup and bounded progress

- Provider: https://api.spacexpanse.org:1234, main chain, pinned genesis; HTTPS without credentials/query/fragment. Optional runtime overrides are ROD_API_URL, ROD_MARKER_KEY, paired ROD_ANCHOR_HEIGHT/ROD_ANCHOR_HASH and ROD_BOOTSTRAP_TXID (requires an anchor). Persisted identity/provider/anchor cannot be silently replaced.
- Fresh installation pins a start header at max(0, tip−10) unless explicitly anchored. A retained authenticated registration journal can recover its bootstrap and earlier anchor on upgrade. Existing lineage requires a pinned bootstrap; first registration uses **bounded_chain_rejected_duplicate**, not proof of global name absence (the API has no name lookup). A duplicate registration may be rejected by the chain; do not interpret this policy as absence proof.
- Spend defaults: name output 1,000,000 base units, marker 600, estimated fee 20 units/byte, absolute fee cap 100,000 and fee-rate ceiling 100 units/byte. Up to nine funding inputs plus the name input; coinbase maturity 100. Initial readiness preflights name minimum + maximum fee + dust = 1,100,600 units; established readiness preflights 100,600 excluding the retained name head. Split funding is supported within the input bound; these are experimental code defaults, not verified live relay policy or a grant to spend.
- Readiness and preparation share value-aware funding selection: at most 12 distinct candidates are authenticated and at most nine funding inputs selected (plus the retained name input). Advertised values order candidates only; exact raw output/value, canonical inclusion, app script and maturity checks establish spendability. These limits remain inside the tick's shared 36-provider-fetch budget, not extra fetch allowances; exhaustion can fail closed before all candidates are inspected.
- Cron runs every minute; accepted 202 submissions can additionally schedule background work. Each tick has a 36-provider-fetch/55-second initiation budget, 10-second request timeout, no inner transport retries and one acquisition attempt. Durable progress handles one up-to-100-header chunk, one history page and one raw observation per acquisition pass. Overlap returns job_busy; a 90-second SQL job lease fences acquisition, not signer takeover.
- Direct provider defaults separately allow two GET retries (250 ms incremental delay), three acquisition attempts, ten history IDs/page, 500 pages, 20,000 header span and a 4,000,000-byte streaming response bound. Delivered bytes, including decompressed/chunked responses, are counted before copying/decoding; oversized bodies and timed-out reads are cancelled/aborted. The durable follower resumes across ticks beyond that original span, rechecks 30 headers and keeps a checkpoint 60 blocks behind tip plus ten predecessor timestamps. Checkpoint-crossing/deep reorg uncertainty fails closed, retaining journals.
- Authenticate raw txids and prevouts, recomputed header hashes/merkle roots, canonical inclusion order and hash-linked ancestry. Count/page exhaustion and end-tip rechecks detect incomplete/drifting responses; **one API remains trusted for completeness and chain selection**, not independent consensus, PoW validation or omission proof. Do not add an unauthorized node/provider fallback.
- Exact raw outbox precedes broadcast. Maximum four identical-byte broadcast attempts; no alternate spend after timeout, no re-signing included predecessors and at most one globally unconfirmed app transaction.

### Readiness and errors

The leaderboard response includes publisher readiness when configured. Availability requires unpaused SQL state checked within three minutes; stale readiness yields publisher_stale. Configuration errors include issuer_not_configured, storage_not_configured, rate_secret_not_configured, funding_compression_incompatible and invalid_publisher_configuration. Startup reports initial_sync until acquisition/reconciliation completes. Operational codes include funds_unavailable, bootstrap_pin_required, identity_configuration_mismatch, checkpoint_mismatch, history_changed/history_page_gap, wrong_network, conflict_suspected, signing_unknown and retry_exhausted. SQL stores a whitelisted sanitized error, pauses readiness and retains journals; the scheduler itself can return generic publisher_unavailable. Unknown errors are not exposed as provider payloads. Missing SQL/grants can produce backend_unavailable. Diagnose the prerequisite; never clear journals/barriers to force readiness.

### Read-only versus finite funded acceptance

The separate [acceptance utility](../tests/live-publisher-acceptance.js) reads inherited runtime bindings only, never dotenv/config/secret files. Default execution performs storage readiness and provider status reads without scheduler, lease, signing or broadcast:

    node tests/live-publisher-acceptance.js

Optional --check-sql acquires/releases a SQL job lease and checks overlap fencing; it is **not read-only**, does not publish and is not multi-session hosted-concurrency proof. Optional HD1_ACCEPTANCE_WORKER_URL must be HTTPS without credentials/query/fragment; it checks the deployed leaderboard response shape and secret non-exposure. Neither option deploys anything.

Only with separately approved funding, existing consented queued claims and this explicit finite spend scope:

    node tests/live-publisher-acceptance.js --publish --name=g/huarong-lb --max-broadcasts=1 --max-fee-units=100000 --max-new-locked-units=1000600 --ticks=2

Exact supported flags are --publish, --resume-scope, --check-sql, --name, --max-broadcasts, --max-fee-units, --max-new-locked-units and --ticks. Value options use equals syntax. Publication requires the exact name, 1–4 broadcasts, 1–100,000 total fee units, 0–1,000,600 newly locked units and 1–10 ticks; defaults are one tick and zero budgets. It creates no player claim. SQL installs durable finite authority before scheduler/signing work, snapshotting only queued claims without raw bytes. Opening rejects an existing scope, a live job lease, preexisting unsigned preparation, ambiguous signing, or raw state other than included/confirmed. Transaction count and cumulative fee/new-lock budgets are checked before preparation and again before signing, then reserved atomically with the non-expiring signing barrier. Each transaction consumes these budgets once, including ambiguous signing responses; retries do not charge fees/locks again. New locks count marker dust plus any increase over the carried name amount (the full name amount for registration). SQL separately caps broadcast attempts, including identical-byte retries, at the selected maximum; the same flag bounds transaction count. Scope/generation checks require the exact persisted outbox. Utility exit, job completion/lease expiry, cron and restart retain scope and counters: ordinary cron without the scope is fenced; no automatic clearing, reset, refund or widening occurs. A later publication invocation cannot replace an existing scope. The example authorizes nothing by itself and may finish before publication during initial sync. A successful utility result is not full acceptance: observe inclusion, independent reconstruction, hosted concurrency and required confirmation thresholds separately. Do not run an unbounded publication command.

Save the initial JSON result's scope_id and cumulative reserved_transactions, broadcast_attempts, fee_units and new_locked_units; broadcasts counts only the current invocation's transport calls. Continue the original immutable authority, substituting the returned UUID:

```bat
set HD1_ACCEPTANCE_SCOPE=RETURNED_SCOPE_ID
node tests/live-publisher-acceptance.js --resume-scope=%HD1_ACCEPTANCE_SCOPE% --ticks=10
```

Resume permits only --resume-scope and optional --ticks=1 through --ticks=10 (default one). Do not add --publish, --name, --check-sql or any budget flag. It checks the installed scope ID/name and uses the same durable job lock; it never reopens authority, widens the queued snapshot or resets counters. A mismatch returns finite_scope_mismatch. If the initial response was lost before scope_id was saved, securely retrieve the existing finite_scope.id using the server-only operational RPC; do not rerun --publish, invent an ID or clear state. This is recovery of durable authority, not new spending authorization.

Run the same resume command after initial_sync/ready or retry_later, and again after a lost broadcast response (broadcast_unknown) or broadcast_pending. Retry only identical persisted bytes within remaining broadcast authority; exhausted authority cannot be topped up by resume. Reconciliation can still proceed after all broadcast authority is consumed. Wait for canonical chain progress, then run the same command to reconcile inclusion and again at six confirmations to establish confirmed ranking; check the deployed leaderboard and independently reconstruct authenticated history using section 7. At twelve confirmations, run it again for weekly close when applicable. Ordinary cron remains fenced and **does not reconcile scoped work**; GET/status also does not advance it. Inspect outcomes and readiness, not ok alone; unresolved signing, reorg/conflict or budget failure is not a pass and must not trigger state clearing. Actual live observations remain required.

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
- In disabled/static mode, same-origin score POST returns HTTP **503** issuance_disabled (or a precise configuration/readiness code); a cross-origin rejection is not a substitute. With all four bindings and fresh readiness, valid consented claims can queue with 202. The empty-body probe is not a valid claim and must not be treated as a publication check.
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

1. Set HD1_PUBLISHER=false through the authorized runtime dashboard first to stop issuance; removing HD1_READS alone does not disable a fully configured publisher. Disable optional reads/remove unnecessary credentials as appropriate. This does not erase chain data or cancel already signed/broadcast transactions.
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

Before restricted funded E1: secure limited-funded compressed signing input, approved network/name/bootstrap policy, authenticated provider-anchored prevouts/history/header ancestry, verified live fees/name minimum, explicit fee/locked-output spend envelope, hosted operational state and independent raw replay. A historical 1 ROD ceiling is **not** spending authorization. Experimental hd2 numerical ceilings are selected and implemented; before public use, pass E1 and hosted validation, complete parent-owned security/Code Reviewer gates and obtain separate public-use authorization. No fixture, packaging result or documentation approval satisfies those gates.
