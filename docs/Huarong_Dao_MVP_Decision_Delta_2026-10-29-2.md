# Huarong Dao — Combined Decision Delta (29 October 2026)

**Type:** Corrected, combined addendum — D5, D6, and the required portable-relay architecture D7.  
**Basis reviewed:** Uploaded `huarong-dao.zip`, including `tasks/plan.md`, `worker.js`, `wrangler.jsonc`, and `leaderboard/` modules. D7 reflects the latest explicit architecture direction and supersedes conflicting repository-plan wording.  
**Scope:** Experimental MVP. This file records requested changes but does not modify source code, the previous plans or deployment.

## D5 — Explicit ranked eligibility before receipt publication

- **Frozen direction:** Results outside a *published, versioned ranked-eligibility limit* are local-only and do not cause an OpenSpeX Receipt or ROD transaction. Evaluate eligibility before receipt assembly or publication; local play and local results remain available.
- **Important current-policy distinction:** The code/plan does **not yet define a numerical ranked maximum or minimum score floor**, and a first otherwise eligible result may qualify even if inefficient. Therefore do **not** silently assume that an unusually long run is disqualified under the existing rules.
- A numerical move-count ceiling may be established per layout, informed by its known optimal move count `O`, **only after** selecting and freezing the actual bound(s). The ceiling must be identical across client checks, authoritative Worker verification, published competition policy and independent receipt reconstruction.
- The complete on-chain receipt must still fit the **2,048-byte UTF-8 ROD name-value constraint**. Never truncate a qualifying run's actions or replace a full inline receipt with a hash while claiming full on-chain evidence. Until verified ceilings cover every allowed run, retain explicit oversize error/local-only behavior.
- **Verification gate:** For each proposed maximum, test a complete worst-case canonical receipt (rules, board, actions, signatures, JSON wrapper) against the exact on-chain byte limit, and test boundary and version-mismatch cases.

**Unresolved:** The actual numeric ranked move-count ceiling(s). No automatic eligibility change is implied by this document.

## D6 — Shared-name ROD publication after one confirmation

- **Frozen MVP decision:** Keep the existing shared ROD name **`g/huarong-lb`** and its register/update transaction history. The next queued receipt may be published after the previous shared-name operation has **one confirmation in the canonical ROD chain** and the previous name output/lineage has been reconciled.
- **At most one unconfirmed shared-name operation** may exist at a time. No speculative unconfirmed chains; derive the next spend from the validated, included predecessor.
- **Separate publication sequencing from finalization:** Keep **six confirmations** for marking receipts as confirmed for finalized leaderboard projections, and retain the existing **twelve-confirmation weekly-close policy**. A receipt with one through five confirmations is included but not finalized.
- Reorganizations must pause new dependent issuance when necessary, reconcile the shared-name head and Supabase records, and rebuild affected projections. Persist exact signed raw transactions and txids before broadcast; resolve ambiguous delivery without signing a different transaction merely because a response was lost.
- **Retrieval rule unchanged:** Supabase serves indexed leaderboards; independent reconstruction must enumerate and verify **all historical shared-name transactions**, not just the current name value.
- **Precise replacement in `tasks/plan.md` §7:** Replace any requirement to wait for **six** confirmations *before issuing the next shared-name update* with: *Wait for one canonical-chain confirmation and successful head/lineage reconciliation. Keep six-confirmation result finalization and twelve-confirmation weekly-close requirements unchanged.*
- **Verification gate:** Broadcast first name operation; after its first canonical confirmation, permit one successor; show that the earlier receipt remains non-final until six confirmations. Exercise chain reorganization, restart, concurrent submission, historical reconstruction and exact-transaction retries.

## D7 — One portable, self-contained `relay.js` (CORRECTED / binding architectural change)

**Frozen target:** There must be exactly **one distributable relay implementation, `relay.js`**, containing the entire operational relay logic needed by both Cloudflare Workers and a direct Node.js command-line executable. **`worker.js` is only a thin Cloudflare-specific adapter**. It imports and invokes `relay.js` **in the same Worker process**, passing Cloudflare bindings/context and forwarding API requests; it must not implement a second verifier, issuer, state machine, receipt encoder or signing workflow.

### Current repository discrepancy (confirmed from the supplied ZIP)

- `wrangler.jsonc` currently declares `main: "worker.js"`; that entrypoint name itself is not the problem.
- **There is currently no `relay.js` in the repository.** Instead, `worker.js` implements `handleApi()`, eligibility/rate admission orchestration and request routing, and imports `leaderboard/storage.js`, `verify.js`, `issuer.js`, `index.js`, and `receipt.js`. Further relay functionality lives in `leaderboard/chain.js`, `reconcile.js`, `profile.js`, etc. This is *not* the requested portable relay artifact.
- `tests/runtime-worker.js` is a test fixture, not the portable relay.
- `tasks/plan.md` currently directs the implementation to keep the Worker entry and use `leaderboard/` modules, and explicitly says not to introduce a second runtime entry. **That previous interpretation is superseded where it conflicts with the portable `relay.js` requirement.** It was incorrect to interpret "one relay" as merely "one Cloudflare deployment".

### Required deployment/execution model

```text
Browser / public/index.html
          |
          v
Cloudflare worker.js                Local Node.js / packaged executable
  - HTTP/asset adapter                 - CLI command + stdin/file input
  - Cloudflare env bindings            - process env / explicit configuration
          |                                         |
          | same-process import                      | direct execution
          v                                         v
     +-----------------------------------------------------+
     |                ONE relay.js                         |
     | claims | replay | eligibility | scoring | receipts  |
     | Supabase journal | ROD signing | broadcast/recovery |
     | reconciling | rankings | protocol/API operations   |
     +-----------------------------------------------------+
                         |                       |
                         v                       v
                    Supabase                  ROD network
```

- **Cloudflare mode:** `worker.js` performs minimal adaptation: route `/api/*` to the imported `relay.js` entry function, provide Cloudflare secret bindings/context, and serve static assets. It does *not* call a separately hosted Node server, spawn Node, or implement duplicate relay policy. The relay code must be compatible with the Workers JavaScript runtime.
- **Node mode:** `node relay.js <command>` runs the **same** relay implementation directly as a one-shot CLI application. It must **not** open an HTTP listener or require a continuously running Node service. Offline receipt verification/replay must work without network or Supabase where its evidence is self-contained. Operations that actually index submissions, broadcast ROD transactions or update hosted rankings still require the configured Supabase and ROD network endpoints; "without server" means **no separate relay HTTP server**, not "no external infrastructure".
- **Executable distribution:** `relay.js` must be a **single self-contained runtime JavaScript file** (with third-party JS bundled when necessary) so it can be run with a supported Node.js version and later packaged as a standalone Node executable. Test the packaging mechanism instead of claiming an untested executable exists. No `leaderboard/*.js` module imports, local `node_modules`, native database driver, or separate custom server should be required **at runtime** by the distributable `relay.js`.
- **Source organization:** Source modules may remain for maintainability **only as build-time inputs** to generate the single `relay.js` distribution artifact. Alternatively maintain it directly as a single source file. Do not let Cloudflare and Node use different independently maintained relay logic. If bundling is selected, require reproducible build/test commands and prevent a stale bundle from being deployed.
- **Runtime boundaries:** Avoid unconditional Node-only imports or APIs in the shared Worker-executed path. The Node CLI startup and any Node-only I/O must execute only when the file is launched directly under Node, never when imported into the Worker. Prefer portable `fetch`, Web Crypto and explicit storage/chain interfaces. Preserve the existing issuer/player key separation, Supabase transactional fences and exact transaction outbox.
- **Single authority:** Both execution modes enforce the *same* versions, player claim validation, replay/scoring, receipt canonicalization, ROD serialization, one-confirmation publication gating, six-confirmation leaderboard finalization, idempotency and reorg logic. Do not create a Node-only shortcut that bypasses Supabase concurrency controls or makes competing app-WIF publications.

### Concrete change targets

1. Introduce a shared relay entry API such as `handleRelayRequest(request, bindings)` plus direct Node CLI commands (`verify`, `reconstruct`, `status`, and explicitly authorized operational commands as required). The names are illustrative; behavior and portability are binding.
2. Move all relay decision-making out of `worker.js`; keep it as minimal HTTP/static-assets glue invoking `relay.js` directly.
3. Produce **one** `relay.js` runtime artifact containing the relay's complete necessary code. The Worker imports the **same** file Node executes; bundling may preserve modular development sources.
4. Maintain existing Supabase storage, ROD transaction protocol and immutable receipt bytes. Do not introduce a new server, OSG runtime, new datastore or second relay service.
5. Add parity tests: a fixed claim/receipt must yield identical accepted/rejected decisions, signatures, receipt IDs, scoring, ranking and transaction preimages in Worker and Node modes (with deterministic fixtures/mocked chain). Exercise `node relay.js verify` without an HTTP server; test a clean environment with no project `node_modules`; test executable packaging when added. Never run live signing/broadcast in tests using real secrets.

**Acceptance gate:** One distributable `relay.js` runs directly under Node.js without any listening server and is the only logic imported and invoked by Cloudflare's thin `worker.js` for relay behavior. There is no duplicated implementation or divergent protocol result between the two modes.

**Status:** Frozen architecture, **not implemented** in the inspected ZIP. This delta corrects the previously issued D7 assertion that no refactor was required. It does not itself authorize production deployment, spending or secret use.

## Unchanged architectural decisions

- **Supabase** remains the MVP durable journal, receipt index and leaderboard projection backend; the **OSG Cloudflare storage adapter** remains a **future-only migration path**, not implementation scope.
- **OpenSpeX:** one universal receipt standard; Huarong Dao uses complete **inline, independently replayable** on-chain evidence. Referenced evidence is a future optional capability for other applications, not an MVP escape hatch for oversized Huarong results.
- **ROD:** continue using the shared historical name chain for the current implemented MVP; independently reconstruct finalized results from confirmed receipts and approved competition rules.
- **No payouts, OSG runtime, Nostr expansion or new Node HTTP server** are added to the MVP by these deltas. The standalone Node CLI is a second execution mode for the **same relay**, not a separately deployed service.
- Existing restricted live-chain E1 gates and the deployed public-issuance-disabled state remain in place until validated.

**Status:** Corrected combined decision delta only. D5 and D6 remain as previously frozen; D7 explicitly supersedes the erroneous prior "one Worker equals one relay" interpretation and conflicting statements in `tasks/plan.md`. The original repository and earlier files are unchanged; only this addendum was revised.
