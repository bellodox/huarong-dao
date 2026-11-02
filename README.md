# Huarong Dao: resilient publisher address reads

Target: `bellodox/huarong-dao`, branch `leaderboard`, inspected HEAD `a462741725cadd56527e9329c10549eb1477d1cf` (2026-11-02).
Verified pre-patch Git blob SHAs: `leaderboard/provider.js` `d5663fb454b6f30a1bbe81234adc0def5285bc66` and `leaderboard/publisher.js` `96f990fd042766ba7c1966e2b9f99291c1a87fbb`.

## Root defect addressed

The production scheduler passed `retries:0` to the transport, even though address reads from `/history/<ROD-address>` and `/unspent/<ROD-address>` are idempotent and the transport already classifies upstream error envelopes containing `ElectrumX` as `provider_unavailable` with category `electrumx_error`. One such envelope aborts `runPublisher`, invokes SQL `job_error`, and pauses publication. If it arrives during the post-preparation check, the score remains `unsigned_preparing` until the next job reclaims the expired lease. Repeated isolated errors explain increasing claim generations without a signed score transaction.

## Fix

- `leaderboard/provider.js`: add optional, validated `addressReadRetries` (0..2). Only retry **GET** requests for `/history/` or `/unspent/` **when** an API envelope was classified as `electrumx_error`, and only when the caller explicitly opts in. Existing transport retry semantics for all other cases are unchanged.
- `leaderboard/publisher.js`: opt in to two additional address GET attempts (three total), using existing 250 ms/500 ms delays, the existing bounded publisher fetch function and its 36-call/55-second caps.
- `tests/publisher-electrumx-resilience.test.js`: regression coverage for a single read failure during marker-history acquisition, a single unspent failure *after* an unsigned preparation was persisted, a persistent failure with safe recovery on a subsequent tick, and no retries for broadcasts/unrelated errors.

**Unchanged:** No ROD API modifications, no new ROD address conversion, no Supabase migration, no signed transaction mutation, no changes to broadcasting/rebroadcast policy, no new spending scope, no widening of transaction budgets or job leases, no unsafe bypass of UTXO/history checks.

This patch addresses transient upstream error envelopes; it cannot make a permanently failing endpoint work. It must be tested on Cloudflare to establish whether it resolves the observed hosted incident.

## Install in a local checkout

From the root of the exact branch, after checking for unrelated local edits:

```sh
git status --short
git apply --check /path/to/huarong-electrumx-codefix.patch
git apply /path/to/huarong-electrumx-codefix.patch
cp /path/to/tests/publisher-electrumx-resilience.test.js tests/
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
```

The `npm run build` step **must regenerate the checked-in `relay.js`** from source; the active Worker imports that generated distribution, not `leaderboard/provider.js` directly. Include rebuilt `relay.js` in the eventual reviewed changes. Do not deploy source changes alone while the bundle is stale. The production GitHub/Cloudflare workflow must be separately authorized.

For manual replacement, the ZIP also contains complete `leaderboard/provider.js` and `leaderboard/publisher.js` at the inspected HEAD with the patch applied. Do not overwrite a different checkout revision without checking differences.

## Verification performed for this package

- Inspected the actual `leaderboard` branch source and generated `relay.js` through the GitHub connector.
- Confirmed existing source files in the package matched the repository's Git blob SHAs before editing.
- `git apply --check` + `git apply` on the original files: PASS; byte-for-byte match with packaged updated source.
- `node --check` on both changed JS source files and new test: PASS.
- Five isolated Node tests using the actual patched provider transport code (with stubbed unrelated imports): PASS. These test one transient history failure, one transient unspent failure, a persistent error bounded at three calls, no retry for invalid addresses/other routes/broadcasts, and invalid retry configuration.
- Full repository integration tests in the added `tests/publisher-electrumx-resilience.test.js`: **not executed here** because the complete checkout/npm dependencies are unavailable. Run them after installation.

## Expected outcome

After a successful build and deployment, a single transient ElectrumX envelope in `/history` or `/unspent` no longer aborts the publisher. If all three read attempts fail, the publisher still fails closed, preserves the unsigned claim, and retries on the next scheduled tick. When health is restored, an expired unsigned lease is reclaimed by the existing SQL job path; the claim can then be signed and broadcast once under the existing continuing-beta authority.

Check for `publisher.code='ready'` and a new, non-null `txid` for `Player32410`; then separately verify canonical inclusion and required confirmations. Neither a successful score POST nor an unsigned preparation constitutes a blockchain transaction.
