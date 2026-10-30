# Huarong Dao

Beta **0.1.0-beta.3 candidate** — a browser sliding-block puzzle with Bulgarian and English UI, 14 layouts (3 unscored practice and 11 ranked), optional assistance, and on-device scores. Prepared and locally validated, not deployed. See [release notes](CHANGELOG.md).

## Experimental leaderboard architecture

The [normative plan](tasks/plan.md) incorporates the decision deltas and authorized execution extension. Implementation includes player-signed actual-path evidence, independent Worker replay, Supabase SQL reservations/exact raw outbox, a live provider adapter and autonomous bounded publisher. The [execution handoff](tests/release-evidence.md#live-publisher-current-scope) is the single current source for completion, measured validation and review status. The [original snapshot plan](docs/Huarong_Dao_Public_Leaderboard_Cloudflare_Supabase_MVP.md) is historical. No launch Durable Object, player transaction, rewards or transfers are introduced. Hosted Supabase, funded publication and deployment remain unverified; provider-anchored history is not independent consensus or omission proof.

### Versioned ranked policy and portable relay

The [combined D5–D7 delta](docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) and [execution extension](tasks/plan.md#14-live-public-leaderboard-execution-extension) govern. Experimental hd2 implements inclusive 10× frozen-optimum ceilings for eleven ranked layouts (820–1260 moves), preserving hd1 semantics and unlimited complete local paths. Successors require one canonical confirmation plus reconciliation; ranking finalizes at six and weekly close at twelve.

The [self-contained relay](relay.js), built from [relay source](leaderboard/relay-entry.js), is now shared by a thin same-process Cloudflare adapter and a direct, non-listening Node 24.2+ CLI. Offline verification/reconstruction needs no network, database or project dependencies; status requires configured server reads. Build/test still needs locked project packages. Executable packaging is not implemented. The separate [acceptance utility](tests/live-publisher-acceptance.js) has read-only and finite approved publication modes; neither is a relay CLI command. [Migration 002](supabase/migrations/002_d6_included_successor.sql) adds durable included state and retained raw lineage for one-confirmation reconciled successor eligibility. Included predecessors never re-sign or rebroadcast. Current evidence and independent review status belong only in the [handoff](tests/release-evidence.md#live-publisher-current-scope).

## Safe default: local-only play

Open [the game](public/index.html) in a browser, or serve the asset directory with a local static HTTP server. Browser storage restrictions can prevent saving when opening a local file; use a local HTTP origin if needed. No package installation or build is required for the static game.

The [Worker](worker.js) never injects a private key into HTML and ignores the old issuer binding. Public submission fails closed without all four runtime bindings and fresh publisher readiness; HD1_PUBLISHER=false explicitly disables it. Walletless board viewing and play do not create an identity or load the signing bundle. Scores, exact run evidence and the player name stay in browser storage; clearing site data removes them. Static/file play remains local when the backend is absent.

- Training starts each load (24 single-cell moves minimum, unscored). **Choose Layout** opens the picker, which groups practice and four ranked difficulty tiers; Classic (116 moves minimum) is in the top tier.
- Training, First Steps, and Next Steps are unscored practice: no score saves, nickname commitment, or public submissions. Legacy practice-only records do not lock the nickname; stored records for deferred layouts are retained but excluded from the current selector.
- Assistance (hints, automatic steps/playback, or opening the solution list) excludes that run from scoring.
- The first eligible score requires nickname confirmation. The verified score record locks the name across reloads; a failed save does not commit the name.
- Personal bests are retained independently of the last five local results. A failed local score save can be retried from the victory dialog.
- Story and device-specific install instructions are available in-game; native PWA installation is not required.
- The layout and solution dialogs support keyboard focus containment, Escape, backdrop dismissal, and focus restoration. The bilingual beta badge fits a 320px-wide viewport.

### Optional analytics

Google Analytics loads only after affirmative analytics consent, independently of public-score consent. Reopen Cookie settings under Leaderboard to withdraw consent. Withdrawal disables further analytics and attempts to delete root-path GA cookies for the host and parent domains; remembered rejection also performs cleanup at startup. Already-sent requests cannot be recalled. These controls do not make all other page resources offline or first-party-only. Live analytics delivery has not been verified.

Revocation in another tab disables analytics here through storage events, with additional checks on focus, return to visibility, and page restoration. Acceptance in another tab never automatically enables analytics in an already-open tab. Cookie settings closes Leaderboard and moves keyboard focus to Necessary only.

Rejection is read back to verify persistence. If saving it fails, the game tries to remove and verify removal of a stale stored grant. If neither operation succeeds, analytics stays disabled in this tab, but the old grant may enable it again after reload. A visible Bulgarian/English warning explains this limitation and offers retry by allowing browser storage and choosing Necessary only again.

## Cloudflare deployment (operator action; candidate not deployed)

Follow the [GitHub push → Workers Builds guide](docs/cloudflare-deployment.md#2-primary-workflow-github-push-to-workers-builds): the existing repository is bellodox/huarong-dao, with leaderboard as the current intended production branch. Cloudflare installs locked dev dependencies, builds both bundles, tests, then deploys; normal operation requires no GitHub Actions, Pages or local Wrangler login/deploy. Exact dashboard commands/variables and external permission checks are in the guide; local dry-run/CLI recovery is secondary. Disabled/static mode needs no wallet or Supabase; optional reads and publication use migrations 001 → 002 → 003 → 004. Current scope and final review status are in the [handoff](tests/release-evidence.md#live-publisher-current-scope). No hosted build/deployment, cloud authentication probe or remote publishing was performed. Funded E1 and full live acceptance remain separate; push/build does not apply SQL or runtime secrets. Configured runtime publication requires all four bindings and fresh readiness.

### Optional public scoring — experimental and unverified live

Publication requires explicit independent public-score consent. Only then does the browser create/reuse a player identity and sign complete evidence; it does not create a player chain transaction. The application signs and funds the receipt transaction server-side. A complete receipt must fit 2,048 UTF-8 bytes; oversized evidence remains intact and local. The tested technical choice is not public-policy approval; see [capacity evidence](tests/release-evidence.md#capacity-choice).

The [operator runbook](docs/cloudflare-deployment.md#5-runtime-configuration-and-live-publisher) gives exact configuration, startup/spend defaults, readiness errors and acceptance commands. Apply only missing migrations in order: [001](supabase/migrations/001_leaderboard.sql) → [002](supabase/migrations/002_d6_included_successor.sql) → [003](supabase/migrations/003_live_publisher.sql) → [004](supabase/migrations/004_finite_publication.sql), each complete/atomic. Runtime schema readiness requires 004; its SQL-durable finite authority snapshots queued unsigned claims, rejects preexisting preparation/ambiguous signing/unconfirmed raw state, checks budgets before preparation/signing and reserves them atomically with the non-expiring barrier. Cumulative fees/new locks count once per transaction; broadcast attempts are separately capped. Cron/restart never automatically clears, resets or widens scope. Preserve journals, reservations and signing barriers. Push/build does not install SQL or runtime secrets.

Publication requires four server-only runtime bindings: ROD_APP_WIF, SUPABASE_URL, SUPABASE_SERVICE_KEY and HD1_RATE_HMAC_KEY (32–256 UTF-8 bytes). **WIF alone is insufficient.** Fund only the compressed app P2PKH address, never the public-only marker; uncompressed app WIF is incompatible. Never expose values in browser code, logs or documentation or inspect restricted secret files. Optional reads without publication require HD1_READS=true and both Supabase bindings. Outside an installed finite scope, the one-minute cron advances durable acquisition/reconciliation independently of HTTP traffic; GET/status never signs or broadcasts. Missing/drifting history and checkpoint-crossing reorgs fail closed.

Migration 004 alone exposes readiness capability revision 4, required by HTTP and publisher before job acquisition, preparation or signing; 003-only returns schema_upgrade_required. Finite acceptance returns a durable scope ID; resume that same immutable scope with optional 1–10 ticks and no new budgets. Ordinary cron is fenced while it exists and does not reconcile scoped work: follow the [exact continuation commands](docs/cloudflare-deployment.md#read-only-versus-finite-funded-acceptance) after sync, lost responses and confirmations through confirmed ranking. Shared value-aware readiness/preparation authenticates at most 12 funding candidates and selects at most nine funding inputs within the publisher's shared 36-fetch tick budget.

The [admission boundary](leaderboard/relay-entry.js:38) also requires trusted platform-provided client IP, uses domain-separated HMAC buckets and checks per-IP before global capacity. Scheduler job acquisition cleans rate records older than ten minutes. Never trust a client-supplied IP header outside the trusted platform boundary or reuse fixture keys live. The [public-read boundary](leaderboard/storage.js:11) is lock-free STABLE SQL, bounded to 100 rank rows plus 20 pending rows and 256 KiB; leaderboard cache lifetime is five seconds.

The separate [loopback fixture entry](tests/runtime-worker.js) demonstrates the end-to-end flow with publicly known test keys and a mock transport, not spendable funding. Never deploy it. Any former exposed issuer must be treated as compromised and never reused.

### Rollback

Disable issuance before rollback. The [SQL rollback](supabase/001_leaderboard.rollback.sql) pauses the coordinator and revokes RPC execution while retaining claims, exact raw transactions and reservations. Never delete the outbox or reset an ambiguous signing barrier to make a retry pass. Reconcile canonical chain/name/input state before resuming. Code rollback cannot undo broadcasts.

Before any future live change, record a known-good deployment/version and preserve routes/bindings securely. No target URL, existing deployment or rollback ID was verified in this task. Do not restore the obsolete asset directory or exposed-key HTML injection.

## Validation evidence and limits

Current and historical experimental evidence is recorded in the [execution handoff](tests/release-evidence.md#live-publisher-current-scope). Earlier scope includes core/SQL tests, all five browser regressions, evidence replay, real loopback workerd EN/BG flows and an independent Python raw-transaction/signature/replay oracle. Fresh parent-attributed publisher validation is recorded at the top of the handoff; older counts below are historical. Neither scope establishes live analytics, hosted Supabase concurrency, chain mining or deployment. Older results below retain their historical attribution.

The parent implementation task reported the following **initial local run** results for beta.2 (beta.3's fresh local rerun is summarized in the [changelog](CHANGELOG.md)); these counts are not totals for the later expanded suites. These checks were not rerun during documentation work:

| Check | Reported result |
| --- | --- |
| Node inline script parsing | 13 passed |
| Node Worker contracts | 12 passed |
| [Edge regressions](tests/qa_edge.py) | 44 assertions/checks passed |
| [Locale/viewport matrix](tests/qa_v14.py) | 159 checks passed |
| [Dialog keyboard navigation](tests/qa_dialog_keyboard.py) | 28 assertions passed |
| [Accessibility checks](tests/qa_accessibility.py) | 24 assertions passed |
| [Deep independent checks](tests/qa_deep_independent.py) | 28 assertions/checks passed; all 14 layouts checked for legality and minimum moves with independent Python BFS |

The parent reports that all five on-disk QA suites passed across the workflow. After the later fixes, the affected edge, keyboard, accessibility, and locale/viewport matrix suites were rerun and each exited 0; the unaffected deep/BFS suite retains its initial pass. No later assertion totals are claimed here.

Reported coverage includes Bulgarian/English responsive UI, the 320px beta badge, Training startup, practice/assistance exclusions, cookie consent and host/domain-cookie withdrawal with startup cleanup, keyboard dialogs, and legal solver paths. Native-storage edge checks cover failed and silently lost writes, first-name rollback/readback, cross-tab nickname locking, reload, duplicate suppression, stale retry rejection, and permanent bests surviving the five-result history. Analytics requests are intercepted in QA; this is not live analytics verification.

### Available local QA commands

All five supplied scripts now resolve the public asset relative to the checkout. With Python, the Python Playwright package, and Chromium installed, run each from the repository root:

    python.exe tests/qa_edge.py
    python.exe tests/qa_v14.py
    python.exe tests/qa_dialog_keyboard.py
    python.exe tests/qa_accessibility.py
    python.exe tests/qa_deep_independent.py

The deep script independently BFS-checks all 14 layouts. Optional screenshots/reports use an existing directory selected through QA_OUTPUT_DIR; output is disabled by default. Historical beta results remain in the [changelog](CHANGELOG.md).

The [manifest](package.json) and [lockfile](package-lock.json) pin the local experiment tools. Node 24.14.1, Python 3.13.5 and Wrangler 4.155.0 were exercised. After installing the locked packages locally, available commands are:

    npm run build
    npm run build:relay
    npm run check:relay
    npm test
    npm run build:client
    npm run dev
    python.exe tests/qa_evidence.py
    python.exe tests/qa_reconstruct.py
    python.exe tests/qa_release.py

For the isolated actual-workerd/PGlite browser fixture, use:

    python.exe tests/runtime_servers.py
    python.exe tests/qa_public_ui.py
    python.exe tests/qa_outbox_retry.py
    python.exe tests/qa_ranked_worker.py
    python.exe tests/runtime_servers.py --stop

The [fixture launcher](tests/runtime_servers.py) binds loopback ports 8787/8788/8790, saves owned PIDs/logs, refuses occupied ports, and disables dotenv loading. Stop its owned processes even after a failed browser check. Do not run a second development server on those ports. The fixture uses local PostgreSQL WASM, not hosted Supabase/PostgREST or a multi-process PostgreSQL server. There is no checked-in lint, typecheck or CI command; do not invent one.

## Source layout

- [HTML asset](public/index.html): ordered inline game/scoring/solver/translation logic and actual run evidence.
- [Worker](worker.js): thin same-process adapter and static asset passthrough.
- [Relay source](leaderboard/relay-entry.js) and [distribution](relay.js): shared API/CLI entry and bundled verification/state machine.
- [Leaderboard modules](leaderboard/profile.js): frozen replay rules, signatures, serialization, issuer, storage and reconstruction.
- [Public UI](public/leaderboard-ui.js) and [local signing source](leaderboard/client.js): consent boundary, exact signed retries and identity backup.
- [SQL migration 001](supabase/migrations/001_leaderboard.sql) and [002](supabase/migrations/002_d6_included_successor.sql): atomic operational state, derived index and durable reconciled inclusion/successor guards.
- [Deployment configuration](wrangler.jsonc): asset directory and routing.
- [Agent guidance](AGENTS.md): hidden contracts to preserve.
