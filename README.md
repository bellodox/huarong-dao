# Huarong Dao publisher stability fix (Cloudflare / GitHub)

Target: `bellodox/huarong-dao`, branch `leaderboard`, verified source at HEAD `b08b3b9540b4c883f105880a8e9fabf8f5b63370` (2026-11-02). The modified source files' baseline Git blob hashes are `provider.js=9efe9cddaa6649f70150863d8397f5a478ff59ab` and `publisher.js=c20bbc543d4e3ed3d4cc127156aa2718ddaf1a7c`. The publisher remains disabled by existing `HD1_PUBLISHER="false"` in `wrangler.jsonc`; **this patch does not re-enable it**.

## Findings

1. Existing `acquire()` throws `history_changed` when the ROD tip changes between two `/info` calls, even if the old tip is still canonical and the marker `/history` page is identical. This makes normal block production appear to be a history integrity failure.
2. Existing post-preparation `validate()` rejects all tip extensions, even if the original tip is still canonical, the marker history is unchanged and the current MTP epoch is identical.
3. For an established ROD name, the same scheduler tick repeats the read-only `/unspent` request for head verification and for funding selection, before a separate necessary fresh `/unspent` verification immediately before signing. One of these early reads can be reused safely.
4. Logs do not indicate whether failures occur in acquisition, funding, post-preparation validation or broadcast, so `/unspent` errors could not be localized precisely from previous reports.

## Changes

- `leaderboard/tip-guard.js` **new**: validate that a newer observed tip extends the pinned block through a contiguous, hash-linked `/range` segment (at most 10 new blocks). During both acquisition and pre-sign checks, verify the current 11-header median-time epoch matches the pinned score epoch. Same-height fork, rollback, changed canonical ancestor or epoch change always fail closed.
- `leaderboard/publisher.js`: use that guard at the end of acquisition and at pre-sign validation; keep marker history equality and fresh UTXO checks. Add restricted, non-sensitive per-stage diagnostics. Cache initial verified UTXOs for funding selection within the same tick; never cache the final pre-sign read.
- `leaderboard/provider.js`: accept already verified UTXO rows for this tick's funding selection; do not change the default behavior for any other callers.
- `tests/publisher-tip-guard.test.js` **new**: nine isolated safety and extension checks (passed locally).
- `tests/publisher-live-tip.test.js` **new**: four full-repository regression scenarios using existing PGlite/mock-chain fixtures (requires running the Cloudflare build's `npm test`).

## Installation with GitHub-connected Cloudflare Workers

In GitHub's `leaderboard` branch, replace the two existing JS files with the corresponding files from this package, and add the three new files. Alternatively use `huarong-runtime-fix.patch` in a checkout. No CLI or local Node is required if you edit/commit files through GitHub; Cloudflare's existing build `npm ci --include=dev --no-audit --no-fund && npm run build && npm test` will regenerate `relay.js` on deployment. Keep all other configuration, Supabase rows, and recovery journals unchanged.

Do not upload local test-only `profile.js` or `package.json` from analysis work; **they are not part of this ZIP**.

## Rollout

1. Commit changes while `HD1_PUBLISHER="false"` remains committed in `wrangler.jsonc`.
2. Confirm all Cloudflare build/test steps pass, including the new tests. If any fail, do not enable publication.
3. When ready, remove the disabled setting or set it to `"true"`, commit, and allow Cloudflare to deploy.
4. Check `/probe` and scheduled logs. Each `hd1_publisher_failure` now reports a safe `phase`, such as `acquire`, `head_utxo` or `pre_sign_validate`. A genuine backend read failure can still occur; no change can make a failed live UTXO check safe to ignore.
5. Submit a **new** unassisted score after readiness returns; the old `Player32410` record is cancelled and must remain cancelled. The `SYNTHETIC02` original and confirmed replacement are deliberately unchanged.

## Security / scope

This does **not** introduce a new WIF, change signed/raw transactions, remove any SQL fences, change recovery authority, reset Supabase, bypass the marker history checks, skip the independent fresh UTXO read, retry broadcasts, or claim that a successful `/probe` proves subsequent API calls will succeed. No ROD API changes. The scope remains constrained by the 36-fetch/55-second publisher limits and the existing transaction issuance budgets.

## Verification performed

- `node --check`: both changed existing JS files, new module and both new test modules: passed.
- `node --test tests/publisher-tip-guard.test.js`: nine passed locally, using verbatim `epoch()`/`medianTime()` implementations extracted from `leaderboard/profile.js` for isolated execution.
- `git apply --check` against a clean checkout of the exact baseline provider/publisher Git blob versions: passed.
- Full PGlite integration suite and live Cloudflare deployment: **not run here**. GitHub connector does not have repository write permission (403); no remote commit or deployment has been performed.
