> **Historical source only — superseded.** The [single normative implementation design](../tasks/plan.md), hd1-plan-2, incorporates the [2026-10-29 decision delta](Huarong_Dao_MVP_Decision_Delta_2026-10-29.md). Snapshot/checkpoint architecture, periodic publication, old paths and next-action instructions below are preserved history, not authority. Supabase now owns operational state and the exact raw outbox; ROD carries complete inline receipts independently sufficient for confirmed ranking reconstruction.

# Huarong Dao: Public Leaderboard MVP

**Implementation plan | Cloudflare Workers + Supabase PostgreSQL + ROD API**  
**Prepared:** 2026-10-28  
**Repository:** https://github.com/bellodox/huarong-dao  
**Reviewed reference:** `e711a22e42752821d4b7fef03d28b75164d5cd7c` (`0.1.0-beta.3`)  
**Status:** Plan only. No code change, migration, deployment, or live ROD transaction is claimed.

## 1. Decision and non-negotiable boundaries

Use **Cloudflare Workers to serve the existing static game and its API**, and **Supabase PostgreSQL as the persistent public leaderboard database**. Name the Worker entry point `relay.js`; it replaces the existing `worker.js` WIF-injection behavior. Move index.html to `public/index.html` as the only frontend file. **Replace the current `HUARONG_PUBLIC_ENABLED` gating**, which depends on an issuer WIF being injected into HTML, with availability/configuration discovered from the same-origin leaderboard API. Load signing libraries only when a player opts into a public submission; do not make an application WIF the frontend feature flag.

**MVP:** A player plays locally, opts into publication, uses their *own* existing or newly generated ROD wallet to sign a claim, and submits a legal move sequence. `relay.js` verifies the signature and sequence, derives the score from server-pinned layout data, atomically stores the accepted result in Supabase, and returns the public overall ranking. Independently, a single application WIF **held only as a Cloudflare secret** can periodically sign an application-owned ROD leaderboard name checkpoint and broadcast raw transaction hex using the existing ROD API. Direct RPC is an **optional alternate transport**, never a dependency.

**Explicitly out of scope:** monetary ROD rewards, Nostr, OSG, ANGI, Supabase Auth, per-player ROD name registration, a dedicated Node server, a separate wallet per game, and a comprehensive anti-bot or sybil-resistance system. Preserve the ability to add these later, but do not implement them now.

**Why Supabase rather than a local SQLite file?** Its hosted PostgreSQL database survives Worker restarts and regions, supports transactions and upserts, and can later support weekly score periods and a payment ledger. **Trade-off:** a second hosted dependency; Supabase Free projects can pause after one week of inactivity. **Why not D1?** D1 is simpler and more tightly integrated for a single game, but Supabase is the chosen foundation for future shared SpaceXpanse game statistics. Do not add Hyperdrive for MVP; use the supported Supabase HTTP client in the Worker.

## 2. Minimal end-to-end path

```text
Browser: docs/index.html
  - play locally; no wallet necessary for practice or anonymous view
  - ranked run logs legal tile actions
  - opt-in -> existing/generated player ROD wallet signs score claim
        |
        v
Cloudflare Worker: relay.js, /api/*
  - verifies player signature + challenge freshness + rule version
  - replays legal moves using pinned board data
  - computes authoritative per-layout points
  - calls Supabase atomic accept-result function
        |
        v
Supabase Postgres
  - players, accepted_runs, personal_bests, chain_checkpoints
  - complete overall leaderboard (not a bounded chain scan)
        |
        +-- immediate GET /api/leaderboard -> browser
        |
        +-- optional scheduled checkpoint -> relay.js
                  - locally builds/signs ROD name tx with app WIF
                  - GET /unspent, GET /transaction, POST /broadcast
                  - RPC optional, status reconciliation required
```

Do **not** send any WIF to Supabase, `/api/score`, a Nostr relay, or the ROD broadcast endpoint. The player sends a public key, signature and move evidence. The application WIF is used only inside the Cloudflare Worker and never injected into HTML as the current `worker.js` does.

## 3. Scoring contract v1 (freeze this before code changes)

There are **14 active layouts**, of which `training`, `first_steps`, and `next_steps` are **practice-only**. The remaining 11 are ranked. Preserve stable layout IDs, including `wings` for Classic. The current beta.3 startup is **Training**; do not change it when implementing the leaderboard.

For a ranked layout:

- `O`: independently verified optimal number of **single-cell** moves.
- `M`: verified number of legal single-cell moves in a completed run, `M >= O`.
- `points = round(10 * O * (O / M)^2)`; equivalently `round(10 * O^3 / M^2)`.
- Compute rounding deterministically, e.g. integer arithmetic on the server, and version the formula.
- A never-completed ranked layout contributes zero.
- The best per-layout result is the run with **fewest moves**. Time may be retained for a casual tiebreak but client time is untrusted; it must not affect points or future payouts unless separately verified.
- The **Overall Score** is the sum of the points of the player's personal best on each of the 11 ranked layouts. No bonus for repetitive inferior runs. At the current stated minimums, the theoretical maximum is **11,740** points (sum of optimum moves 1,174 multiplied by ten).

**Overall order:** overall points descending; count of distinct ranked layouts completed descending; earliest timestamp at which the current total was achieved ascending; stable player ID ascending as final deterministic order. Equal overall points may alternatively be shown as tied ranks, but the API order must remain stable.

**Important:** The minimum-move count is the requested proxy for layout complexity; it is not a proven empirical measure of human difficulty. Preserve the established values and do not silently alter the catalog or scoring formula after accepting public records. Include `rules_hash` and `score_version` in all accepted results.

## 4. Identity and submission

1. Guest starts playing immediately with a generated local nickname. No wallet is created just for viewing rankings or practicing.
2. After a ranked unassisted completion, retain the existing local score flow. Offer **Publish to leaderboard**, with explicit public-display consent.
3. The player wallet remains browser-controlled. Reuse/import the existing `huarong_rod_identity_v1` key if present; never overwrite an existing WIF or rename historical on-chain data. Provide a clear backup/export route before any actual ROD rewards.
4. For an experimental low-stakes MVP, generate a server challenge **when the player submits**. Sign a canonical claim binding domain (`huarong-score-v1`), player public key, run ID, challenge ID/nonce, layout ID, rules hash, move-evidence digest, and expiry. Verify signature and address derivation using ROD-compatible secp256k1 rules. Validate imported wallets and signatures with known test vectors.
5. `POST /api/score` includes this signed claim and the actual ordered action sequence. Never accept a supplied `points`, `optimalMoves`, `solved`, `assisted` flag, timestamp, or `player_id` as authoritative. Calculate validated outcomes on the relay from fixed rules.
6. Verify every move against the initial board, collision and bounds rules, single-cell move convention, and the victory condition. Reject impossible moves, unsolved sequences, excessive payloads, unknown layouts, obsolete rules versions, repeated `run_id`, and expired challenges. Enforce rate and body-size limits.
7. Show an accepted result immediately after the Supabase transaction commits. Queue work locally for retry if offline, but **do not present an unverified offline result as public or reward-eligible**.

The relay proves that a legal sequence solves the puzzle; it **cannot prove a human played unaided**, since users can compute optimal sequences or modify the frontend. Scores must be labeled `replayed` (rule-verifiable), not `human_verified`. Do not activate monetary payouts based solely on this proof.

**Timing:** In this initial design the client timer is display-only. A challenge issued at submit time proves request freshness, **not gameplay elapsed time**. Later weekly reward competitions require start-of-run challenges and a defined server-time policy; those cannot be added retroactively to older runs.

## 5. Worker endpoints (three required)

| Method / route | Input | Output | Authentication |
| --- | --- | --- | --- |
| `GET /api/leaderboard?limit=20` | Optional paging/limit | Overall ranking, player IDs, opted-in nicknames, total points, completed layouts, snapshot version | Public, read-only |
| `POST /api/challenge` | Player public key, intended layout, rules version | Random challenge ID/nonce, expiration, authenticated challenge token | Public, rate limited |
| `POST /api/score` | Challenge token, run ID, public key, signature, action list, intended nickname/consent | Accepted/rejected, computed moves/points, updated overall score | Signed wallet proof |

**No fourth endpoint is required for MVP.** Use `GET /api/leaderboard?player=<id>` (same route) for a player's public per-layout bests. Later add a protected operator/status endpoint if on-chain checkpoint diagnostics require it. Keep challenge and score endpoints same-origin behind the existing Cloudflare deployment to avoid cross-origin complexity.

The challenge can be stateless: the Worker signs an expiring challenge token using an HMAC key, then validates it at submission; enforce `run_id` and challenge ID uniqueness in Supabase so retries are idempotent. A reused challenge must not create additional accepted runs.

## 6. Supabase data model (minimal, forward-compatible)

Suggested tables:

```sql
-- Example schema skeleton; migration must add validated constraints,
-- indexes, ownership grants and RLS policies before deployment.
create table players (
  player_id text primary key,
  public_key text not null unique,
  nickname text not null,
  created_at timestamptz not null default now()
);

create table accepted_runs (
  run_id uuid primary key,
  challenge_id uuid not null unique,
  player_id text not null references players(player_id),
  layout_id text not null,
  rules_hash text not null,
  score_version integer not null,
  moves integer not null,
  reported_time_ms bigint,
  points integer not null,
  evidence_sha256 text not null,
  accepted_at timestamptz not null default now()
);

create table personal_bests (
  player_id text not null references players(player_id),
  layout_id text not null,
  rules_hash text not null,
  score_version integer not null,
  moves integer not null,
  points integer not null,
  best_run_id uuid not null references accepted_runs(run_id),
  primary key (player_id, layout_id, score_version, rules_hash)
);

create table chain_checkpoints (
  seq bigint generated always as identity primary key,
  snapshot_sha256 text not null unique,
  state text not null,
  txid text,
  raw_tx_hex text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Required database transaction: **one atomic operation** inserts the verified run, inserts/updates its player, and conditionally replaces the best for that exact layout+rules version if moves improve (with a deterministic tie policy). A duplicate `run_id` returns the existing decision, not a new result. Use a carefully scoped PostgreSQL function called through Supabase RPC or a single transaction; never implement the best comparison as independent client-side queries followed by a blind overwrite.

`GET /api/leaderboard` computes totals from `personal_bests` using an indexed aggregation or a protected read-only SQL function/view; don't maintain an independently mutable total in the browser. Keep all accepted runs for future weekly accounting, subject to a defined retention policy.

**Security:** The browser never receives a Supabase secret/service-role key. Only the Worker communicates with Supabase using a server-side secret; explicitly revoke anonymous write privileges, enable RLS as defense in depth, and constrain database-function execution. Supabase's service role bypasses RLS, so verification *must* happen in `relay.js` before privileged database writes.

## 7. ROD name checkpoint: first blockchain milestone

**Not per-player registration.** Use one application-owned name, e.g. `g/huarong/leaderboard`, containing a small snapshot header: schema version, monotonic sequence, pinned rules/score version, **top-N public pseudonymous IDs and their points**, and SHA-256 commitment to the entire deterministic public leaderboard export. Ensure UTF-8 value stays within ROD's 2,048-byte name-value limit. Do not publish player names, WIFs, raw move logs, or private mappings by default.

The full leaderboard stays in Supabase and can be exported as a stable canonical snapshot for independent hash verification. A checkpoint hash **does not make the scores decentralized or valid by itself**: it binds the chain state to the particular export, which must be retrievable for an auditor to reproduce it.

**WIF-first chain operations in `relay.js`:**

1. Keep `ROD_APP_WIF` in a Cloudflare secret, not in `docs/index.html`, the repository, Supabase, or request payloads.
2. Read current app-owned ROD name outpoint and required UTXOs through `rod-api-server` (`/unspent/<address>`, `/transaction/<txid>`, etc.). Use satoshi/base-unit arithmetic only.
3. Build the ROD `name_register` or `name_update` transaction locally with the correct name script and prior-output signing path. Reuse audited logic from the existing Huarong implementation, including its long-script handling, but **test the chosen secp256k1/signing library in the Workers runtime before treating the port as complete**.
4. Sign inside the Worker with the application WIF; submit only signed hex to `POST /broadcast` as form field `raw`. Use direct RPC for query/broadcast only if configured and available; it does not sign on the relay's behalf.
5. Save a pending checkpoint and deterministic raw transaction/txid in Supabase. Serialize all updates to the *same* app-owned name. If a response times out, inspect chain/mempool/name state before deciding whether a retry is safe.
6. Mark the checkpoint `confirmed` only after the required confirmations; handle rejected transactions, competing spends, reorgs, fee reserves, and recoverable restarts. Don't overwrite the chain's current state based on an in-flight or old snapshot.

**Operational simplification:** For the MVP, trigger one checkpoint manually after the public leaderboard is working, then optionally enable a Cloudflare Cron Trigger to publish coalesced updates every ~15 minutes. Do not broadcast on each player move or every accepted score. If the chain or signer is unavailable, public rankings continue working, with an explicit `checkpoint_pending` state.

**Signing compatibility is a release blocker for on-chain updates, not for the off-chain leaderboard.** Avoid claiming ROD signing works in Workers until a raw registration and subsequent name update have been validated on the intended chain.

## 8. Exact repository edits

| Path | Change |
| --- | --- |
| `docs/index.html` | Preserve gameplay, Training startup, locale, local score reliability, practice exclusions, and hint/assistance logic. Replace issuer-WIF-dependent feature gating with API-reported public availability, load player-signing code on demand, add compact action log and wallet-signed public submission, and show overall rankings plus per-layout details. |
| `worker.js` | Remove WIF-injection behavior. Replace as the Worker entry with `relay.js` (or keep a trivial asset-only wrapper if strictly necessary). |
| `relay.js` **new** | Cloudflare Worker module: API routing, nonce challenges, signature verification, independent move replay, scoring, Supabase calls, and optional checkpoint signing/broadcast. |
| `wrangler.jsonc` | Point `main` to `relay.js`; preserve static `docs` asset directory; route `/api/*` Worker-first. Add only required bindings/secrets. |
| `supabase/migrations/001_public_scores.sql` **new** | Tables, access grants, RLS, indexes, transaction function, and leaderboard query. |
| `tests/` | Keep existing Python Playwright/BFS suites. Add signature, replay, DB concurrency, migration, and transaction recovery cases. |
| `README.md` / `AGENTS.md` | Update the WIF boundary, API contracts, scoring version, local testing, and explicit deployment status. |

Illustrative Wrangler delta (not a verified deployment file):

```jsonc
{
  "name": "huarong-rod-experiment",
  "main": "relay.js",
  "compatibility_date": "2026-10-28",
  "assets": {
    "directory": "./docs",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  }
}
```

Worker secrets: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CHALLENGE_HMAC_KEY`; add `ROD_APP_WIF` only for chain checkpoint testing; optional `ROD_RPC_URL` plus credentials for optional RPC. Store no real secret in committed configuration, build output or diagnostic logs. A separate application name controller and payout wallet can be introduced later, but do not require it now.

## 9. Three implementation increments (MVL)

### Increment 1 — Real public leaderboard, no ROD transaction

**Deliver:** existing game + same-origin Cloudflare API + Supabase, including wallet identity, signature challenge, move log replay, score formula, atomic durable bests, and an overall leaderboard. Player WIF never leaves the browser. Other users can view the board without wallets.

**Acceptance:** Two distinct player wallets submit legal solutions from independent browsers; both appear in the same overall leaderboard; worse reruns do not add points; duplicates cannot inflate totals; replay of a forged solution is rejected; service restarts do not lose results; no issuer WIF is shipped to the browser.

### Increment 2 — WIF-first application-owned ROD checkpoint

**Deliver:** one app-owned leaderboard name, local construction/signing in `relay.js`, broadcast through ROD API without direct RPC, durable pending and confirmed states. Optional RPC query/broadcast adapter.

**Acceptance:** Test against an actual ROD node/backend with a disposable, limited-funds application WIF. Successfully register then update a name, verify transactions/confirmations, and recover from a simulated timeout without double-spending. API-only route works when direct RPC configuration is absent. Public leaderboard remains operational if ROD API fails.

### Increment 3 — Weekly rewards foundations (not active transfers)

**Deliver later:** fixed UTC week IDs, designated layouts, verified weekly-run snapshots, dry-run allocation reports, payout eligibility flags, beneficiary wallet ownership proof, and a persistent, idempotent payout ledger. Keep reward transfer disabled until bot/sybil policies and transaction authorization limits are decided.

**Acceptance:** A weekly snapshot is immutable once finalized; the sum of provisional allocations cannot exceed budget; no actual ROD transfer is sent in dry-run mode.

## 10. Testing and release gates

- Unit tests: score arithmetic at optimum, non-optimum, high move counts and tie boundaries; independent initial-board replay; all 14 layouts, stable IDs and minimums; legal victory only; forbidden practice/assisted eligibility (subject to client-tampering limitation).
- Cryptography: imported player WIF/address/public-key correspondence; signed challenge valid and tampered; wrong domain/nonce/rules; repeated challenge/run ID; mixed library implementations; one app-name registration and signed update using ROD chain test vectors.
- Database: two concurrent improvements for one player/layout preserve the best; same run retried is idempotent; one wallet cannot claim another; aggregate matches sum of per-layout bests; simulated Supabase outage leaves local gameplay usable; backup/export and restore validated.
- Browser: Bulgarian/English text, 320 px viewport and iOS safe-area, player first-score name commitment, offline/local history, consent independence, no loss of wallet key or score when migrating, no change to Training default.
- Blockchain: API-only no RPC, pending confirmation, rejected transaction, ambiguous broadcast response, UTXO contention, insufficient fees, name update serialization, duplicate scheduled triggers, service restart and reorg reconciliation.
- Deployment: stage in a separate Supabase project or schema with disposable app WIF, then deploy only after explicit authorization. Record previous Cloudflare deployment ID and rollback procedure. Beta.3 in the repository is currently documented as a *locally prepared candidate*, not a verified live deployment.

## 11. Risk boundaries and future migration

1. **Rewards are a different security problem.** A legal, signed solution can come from an automated solver or multiple accounts. No real ROD should be awarded merely because a move log passes replay validation. Freeze eligibility and investigate sybil resistance before payouts.
2. **Legacy player keys and scores:** preserve `huarong_rod_identity_v1` and local score keys. Legacy results without verifiable action evidence remain local or flagged `legacy_unverified`; never silently upgrade them into future monetary eligibility. Prior per-player on-chain names, if any, are not deleted by changing public scoring architecture.
3. **One-key identity:** stable public key is the player identifier; display nickname is separate. WIF can later serve both ROD and Nostr where explicitly verified, but Nostr is not needed now.
4. **Privacy:** public display is opt-in. Minimize on-chain personal fields; a hash or key is not automatically anonymous. Describe visibility, retention and deletion limits before launch.
5. **Supabase availability:** Free projects may be paused after ~7 days of low activity. If that is unacceptable for public production, choose a paid plan or reconsider Cloudflare D1. Implement degraded read/error states and backup/export to avoid lock-in.
6. **State source:** Supabase is authoritative for accepted, verified rankings in the MVP. ROD carries app-signed checkpoints and later monetary settlement; it is not a complete independently rebuilding database at this stage.
7. **Keep the first step small:** implement one signed, verified submission end-to-end with Supabase **before** porting chain signing. Do not build cross-game reputation, season ranks or payout authorization ahead of an operational leaderboard.

## 12. Single next action

Create a working branch (no push or deployment assumed). Replace the old Worker WIF injection with an `/api/*` relay stub, connect it to an isolated Supabase project, and implement the atomic accepted-run + best-result path. Demonstrate **two real browser wallets** on the same leaderboard. Only after that passes, enable the WIF-first ROD checkpoint writer.

---

## Verified references

- Current game: https://github.com/bellodox/huarong-dao/tree/e711a22e42752821d4b7fef03d28b75164d5cd7c
- Cloudflare + Supabase: https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/
- Cloudflare static assets and API routing: https://developers.cloudflare.com/workers/static-assets/binding/
- Cloudflare encrypted Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare scheduled handlers: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Supabase atomic database functions: https://supabase.com/docs/guides/database/functions
- Supabase access control and RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase secret-key handling: https://supabase.com/docs/guides/database/secure-data
- Supabase pricing and Free pausing policy: https://supabase.com/pricing
- ROD API endpoints: https://github.com/SpaceXpanse/rod-api-server/blob/new/server/rest.py
- ROD API backend behavior and network constraints: https://github.com/SpaceXpanse/rod-api-server/blob/new/README.md
- User-provided conceptual reference: *SpaceXpanse Universal Game Protocol Fresh Concept*, October 23, 2026 (13 pages). It describes player-controlled keys, application-owned game names, verifiable claims, privacy boundaries, and conditional ROD settlement; this MVP does **not** claim to implement its future OSG/ANGI/Nostr layers.
