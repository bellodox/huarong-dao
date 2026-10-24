# Changelog

## 0.1.0-beta.1 — initial beta

Prepared for initial release; not yet deployed.

### Added
- Bulgarian/English puzzle UI, eight layouts, optional solver assistance, story, and install guidance.
- [next_steps (50 moves)](docs/index.html:3118) layout.
- Local-only default with nickname confirmation, persistent personal bests, and the last five results. Training and assisted runs are unscored; First steps remains local-only.
- Optional experimental public scoring with explicit consent. The disposable issuer key is exposed in delivered HTML; it is not a private backend credential.

### Fixed
- Failed local score saves can be retried without duplicate results; stale retry/result contexts are guarded.
- Deployment assets use the current [game directory](wrangler.jsonc:6).

### Validation and limitations
- Parent-reported local checks: 12/12 inline parsing, 11/11 Worker contracts with dummy keys, 19/19 browser/storage/UI, 7/7 inert public-queue simulations, and 18/18 final retry regressions; cached Wrangler 4.100.0 dry-run exited 0.
- These are not CI results or live verification. Real public broadcasts, confirmations, and Cloudflare deployment remain untested. See [validation details and release guidance](README.md).
