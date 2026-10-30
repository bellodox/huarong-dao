# Changelog

## Unreleased — experimental live-publisher implementation, 2026-10-30

- Corrected schema gating to require migration 004's readiness capability revision 4 before HTTP availability or publisher job/preparation/signing; 003-only fails closed. Added immutable finite-scope continuation to the [operator commands](docs/cloudflare-deployment.md#read-only-versus-finite-funded-acceptance), with no budget replacement or ordinary-cron reconciliation. Shared value-aware funding authenticates at most 12 candidates and selects at most nine funding inputs within the 36-fetch tick budget.
- Implemented hd2 inclusive 10× optimum ceilings for eleven ranked layouts, preserving hd1 semantics and unlimited complete local evidence; see the [published policy](tasks/plan.md#experimental-profile-decision).
- Added the [single-API provider](leaderboard/provider.js): authenticated raws/prevouts, recomputed header hashes/merkle roots and ancestry; provider-anchored history is not independent consensus or omission proof. Incomplete/drifting history fails closed.
- Added the [bounded autonomous publisher](leaderboard/publisher.js), one-minute cron and [migration 003](supabase/migrations/003_live_publisher.sql) for durable acquisition/bootstrap and job leases, preserving exact outbox and non-expiring signing barriers. Publication needs all four runtime bindings and fresh readiness; WIF alone is insufficient.
- Added [migration 004](supabase/migrations/004_finite_publication.sql), required for current runtime schema readiness: SQL-durable finite authority snapshots queued unsigned claims, rejects preexisting preparation/ambiguous signing/unconfirmed raw state, checks budgets before preparation/signing and reserves them atomically with the non-expiring barrier. Cumulative fees/new locks count once per transaction; broadcast attempts are separately capped. Cron/restart never automatically clears, resets or widens scope. Provider response limits now count streaming bytes before decoding and cancel/abort oversized bodies and timed-out reads.
- Updated the [runbook](docs/cloudflare-deployment.md#5-runtime-configuration-and-live-publisher) with missing-only 001 → 002 → 003 → 004 migration order, each missing file complete/atomic, compressed app-address funding, defaults/errors and read-only versus finite-publication acceptance commands. Push/build does not apply SQL or secrets. No hosted/funded/deployment success is claimed; current evidence and reviews belong only in the [handoff](tests/release-evidence.md#live-publisher-current-scope).

## Historical implementation boundary — 2026-10-29

The following entries describe the earlier disabled-production scope, not the current publisher.

- Corrected the [deployment guide](docs/cloudflare-deployment.md) to the existing GitHub push → Workers Builds workflow, with pinned Node, explicit locked dev install/build/test/deploy settings and secondary local recovery. No hosted build or deployment is claimed; [current scope and final review status](tests/release-evidence.md#github-workers-builds-current-scope) are recorded in the handoff.
- Locally implemented D7: one [self-contained relay](relay.js) shared by thin Worker and direct non-listening Node 24.2+ verify/reconstruct/status CLI, with reproducible build/check and stale-artifact deployment guard. Standalone offline runtime needs no project dependencies; build/test still does. Executable packaging and live publication CLI are not implemented.
- Locally implemented D6: [migration 002](supabase/migrations/002_d6_included_successor.sql) adds durable included state/retained raw lineage and one-confirmation reconciled successor eligibility. Six-confirmation finalization and twelve-confirmation weekly close remain unchanged. Included predecessors never re-sign/rebroadcast; reorg/conflict fails closed. Apply 001 then 002, or atomically upgrade existing 001; preserve journals/reservations and require fresh authenticated reconciliation.
- Added [Cloudflare operator guide](docs/cloudflare-deployment.md) for disabled/static deployment and optional server-only reads. No deployment performed; no command enables issuance. [D5 numerical ranked ceilings](docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md), funded E1, authenticated live adapter/history, hosted tests and public-use approval remain gates. Earlier reviews do not approve this scope; current evidence belongs only in the handoff below.

- [hd1-plan-2](tasks/plan.md) reconciles the [decision delta](docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29.md): Supabase transactional operational reservations and exact raw outbox replace the planned launch Durable Object, preserving complete inline chain receipts and independent confirmed ranking. Stale-owner safety fails closed after the signing barrier.
- Complete actual-path player/app receipts, independent replay and authenticated fixture reconstruction, consent-only identity/signing and in-game Bulgarian/English confirmed/pending views. All 11 ranked layout IDs, including Rain2, are supported; three practice layouts remain excluded.
- Public reads are bounded and separated from operational mutation locks. Server-only HMAC admission limits, authenticated previous outputs, fee ceilings and immutable preparation guard signing. Reconstructed unconfirmed history without a journal pauses issuance; persisted old signed outbox retries survive newer evidence and stop requesting on consent withdrawal.
- Complete receipts use a final 2,048-byte UTF-8 bound with no separate 1,536-move cap; oversized paths remain intact locally. This experimental technical choice is not human public-policy approval.
- The original snapshot plan and its documentation-only reviews are historical. Current validation, scoped independent verdicts and persistence belong only in the [execution handoff](tests/release-evidence.md). Production issuance is hardcoded disabled; live E1, hosted Supabase and deployment remain unverified. This is not live MVP acceptance or launch approval.

## 0.1.0-beta.3 — locally validated candidate

Prepared locally; not deployed, committed, tagged, or pushed. The Worker is unchanged.

### Changed
- Training is now the startup layout (24 single-cell-move minimum, unscored). Classic remains available in the layout picker. The "Starting layout" marker, header label, and bilingual onboarding text follow Training.
- The header button formerly labeled Layouts is now **Choose Layout** (Bulgarian: "Избери подредба"), including its tooltip and accessible name.
- Layout names no longer carry Chinese glyph suffixes (for example "Classic" instead of "Classic (横刀立马)"), in both Bulgarian and English. Layout IDs are unchanged, so stored scores are unaffected.
- The beta badge reads 0.1.0-beta.3.

### Validation and limitations
- Freshly run locally for this candidate: all five Python Playwright scripts ([edge](tests/qa_edge.py), [matrix](tests/qa_v14.py) with 159 checks and 0 failures, [dialog keyboard](tests/qa_dialog_keyboard.py), [accessibility](tests/qa_accessibility.py), and [deep independent](tests/qa_deep_independent.py) with independent BFS for all 14 layouts) exited 0; inline scripts parse (13/13) and the Worker passes a syntax check. The edge, matrix, and deep scripts were updated for Training startup, the beta.3 badge, the Choose Layout label, and glyph-free names.
- Live analytics, real public-score broadcasts/confirmations, public leaderboard integration, and deployment remain unverified. No deployment, authentication probe, commit, tag, or push was performed.

## 0.1.0-beta.2 — locally validated candidate

Prepared locally; not deployed or pushed. Cloudflare is unauthenticated, and no target URL, current deployment, or known-good rollback ID has been verified.

### Added
- Six layouts bring the active catalog to 14: 3 unscored practice and 11 ranked, grouped by difficulty tier. Deferred layouts are outside the active catalog; their stored scores are retained.
- Independent Python BFS minimum-move verification and five checkout-relative Python Playwright QA scripts. See [commands and attributed validation](README.md#validation-evidence-and-limits).
- Separate opt-in analytics controls, with Cookie settings in Leaderboard for withdrawal.

### Changed
- Classic is the startup layout, with a 116 single-cell-move minimum. Layout names and bilingual onboarding now match the catalog.
- First Steps and Next Steps join Training as practice-only: no score saving, nickname commitment, or public publication. Legacy practice-only scores no longer establish a fixed nickname; ranked score durability, verified first-score commitment, best/history separation, and retry guards remain in place.
- Layout and solution dialogs now contain keyboard focus, close with Escape or backdrop clicks, and restore focus to their opener.

### Fixed
- Analytics withdrawal removes host-only and parent-domain root-path GA cookies; startup enforces remembered rejection and cleans stale cookies. Already-sent analytics cannot be recalled.
- Cross-tab analytics revocation is enforced through storage events and rechecks on focus, return to visibility, and page restoration; peer acceptance never automatically grants analytics in an already-open tab.
- Rejection persistence is verified, with verified stale-grant removal as a fallback. If both saving and removal fail, analytics remains off in the current tab and a bilingual warning/retry discloses that a stale grant may enable it again after reload.
- Cookie settings hands keyboard focus from Leaderboard to Necessary only, and numeric move badges translate correctly in English.
- The Bulgarian/English beta.2 badge fits the header at 320px width.

### Validation and limitations
- Parent-reported initial local run, not rerun for documentation: edge 44, matrix 159, keyboard 28, accessibility 24, deep 28 assertions/checks; independent Python BFS legality/minimums for all 14 layouts; Node inline parsing 13 and Worker contracts 12. These are initial-run counts, not later expanded-suite totals.
- The parent reports all five on-disk QA suites passed across the workflow; final affected edge, keyboard, accessibility, and matrix reruns each exited 0. Deep/BFS was unaffected and retains its initial pass.
- The Worker is unchanged. Live analytics, real public-score broadcasts/confirmations, public leaderboard integration, and deployment remain unverified. The [deploy/rollback route](README.md#cloudflare-deployment-operator-action-candidate-not-deployed) is operator guidance, not evidence of a successful rollout. No GitHub push is authorized.

## 0.1.0-beta.1 — initial beta

Prepared for initial release; not yet deployed.

### Added
- Bulgarian/English puzzle UI, eight layouts, optional solver assistance, story, and install guidance.
- [next_steps (50 moves)](public/index.html:3139) layout.
- Local-only default with nickname confirmation, persistent personal bests, and the last five results. Training and assisted runs are unscored; First steps remains local-only.
- Optional experimental public scoring with explicit consent. The disposable issuer key is exposed in delivered HTML; it is not a private backend credential.

### Fixed
- Failed local score saves can be retried without duplicate results; stale retry/result contexts are guarded.
- Deployment assets use the current [game directory](wrangler.jsonc:6).

### Validation and limitations
- Parent-reported local checks: 12/12 inline parsing, 11/11 Worker contracts with dummy keys, 19/19 browser/storage/UI, 7/7 inert public-queue simulations, and 18/18 final retry regressions; cached Wrangler 4.100.0 dry-run exited 0.
- These are not CI results or live verification. Real public broadcasts, confirmations, and Cloudflare deployment remain untested. See [validation details and release guidance](README.md).
