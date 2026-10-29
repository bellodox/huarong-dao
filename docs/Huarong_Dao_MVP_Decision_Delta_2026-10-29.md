# Huarong Dao MVP — Decision Delta

**Date:** 2026-10-29  
**Historical base:** [original source plan](Huarong_Dao_Public_Leaderboard_Cloudflare_Supabase_MVP.md). **Single normative design:** [hd1-plan-2](../tasks/plan.md), explicitly revised 2026-10-29.
**Purpose:** Record the authorized decision delta and rationale. Implementation contracts live only in the task plan; the original snapshot plan is historical, not reauthorized. References below point to current normative sections; the original source remains preserved separately.

## D1 — One conceptual OpenSpeX receipt with evidence placement modes

**Later revision:** The [combined D5–D7 delta](Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) supersedes conflicting relay/execution and publication-sequencing wording. The [current plan](../tasks/plan.md#d5d7-binding-revision) incorporates it. D5 in this earlier document is a historical authority section, not the new ranked-eligibility decision.

**Current reference:** [boundaries](../tasks/plan.md#2-required-end-to-end-behavior-and-boundaries) and [complete receipt](../tasks/plan.md#5-complete-wire-receipt-and-canonical-signatures).

- **Future protocol concept, not standard approval:** A single universal OpenSpeX Receipt may support developer-selectable evidence placement: `inline` or `referenced`. These are storage modes, **not two kinds of receipt**.
- Both modes have identical *verification requirements*, but not identical *availability guarantees*: referenced evidence must be retrievable, authenticated against the signed digest, and sufficient for the claimed assurance. An authentic receipt whose referenced bytes are missing cannot be replayed merely from the hash.
- Storage mode and ROD publication policy are independent choices. Minimal evidence may be deterministic seeds, fixed initial state, action/control decisions, non-reproducible observations, or other information sufficient for the declared verification process; retaining full telemetry is **not automatically required**.
- Assurance must distinguish an issuer's signed verdict from an outcome independently replayed or otherwise cryptographically proven. A hash of open-source verifier code alone does not attest that that code ran, nor authenticate its input data.
- **MVP impact:** None. Keep Huarong Dao's already-specified complete inline, self-contained receipt and mandatory on-chain publication **only for qualifying, verified leaderboard results**. Do not implement the `referenced` mode, OIP-wide generic plumbing, or a revised receipt schema in this experiment.

## D2 — Deterministic, minimum-aware evidence representation is a possible optimization, not a new MVP prerequisite

**Current reference:** [replay profile/scoring](../tasks/plan.md#4-exact-hd1-replay-profile-and-scoring).

- Huarong Dao's existing frozen layouts and known optimal single-cell move counts already define a reproducible starting point and scoring baseline. A random seed is **not needed** for the current fixed layouts.
- Preserve exact replay of **the player's actual chosen path**. The minimum move count, the excess `M - O`, or a hash of a canonical optimal solution cannot on their own reconstruct the player's path.
- A future codec may encode only a deterministically ordered **legal-move choice index** for each step, or deviations from a **specific** canonical optimal path with an explicit fallback. Both require benchmarking against actual valid runs; neither is assumed superior or adopted as a replacement for the base document's current compact piece-index/direction encoding.
- A decoder must be able to reconstruct every move using the original board, frozen rules, action count, and precise codec version. Independent replay and size-limit tests remain unchanged.
- **MVP impact:** No new codec requirement and no scoring change. Retain the base plan's simple action log, deterministic replay, and fixed minimum-move scoring.

## D3 — Future OmniSpatialGraph (OSG) evidence support is optional

**Current reference:** [scope and optional future concepts](../tasks/plan.md#2-required-end-to-end-behavior-and-boundaries).

- For future larger OpenSpeX tasks such as Orbit Challenge, `referenced` evidence may be held in content-addressed storage and indexed through OSG, with a dedicated `relay.js` responsible for submission, access, integrity checks, and verifier coordination.
- When simulation is reproducible from a seed, versioned rules, initial state, and control events, preserve the **minimum non-reconstructible evidence** rather than full telemetry. Where input authenticity or nondeterministic measurements matter, a seed and verifier source checksum alone are insufficient.
- OSG is a provenance/index layer; it need not place every high-frequency telemetry sample in graph rows. Such applications may use external blob/object storage under OSG management.
- **MVP impact:** None. No OSG service, telemetry store, agent interface, or Orbit Challenge integration is added to Huarong Dao.

## D4 — Supabase stays now; OSG storage adapter is an optional future migration path

**Current reference:** [operational ownership](../tasks/plan.md#7-issuer-state-machine-ownership-and-failure-recovery) and [API](../tasks/plan.md#8-worker-api-and-browser-integration).

- **Planned MVP, not current implementation:** [public asset](../public/index.html) → existing [Worker entry](../worker.js) with planned leaderboard modules → **Supabase PostgreSQL** for accepted-submission operational state, transaction and UTXO reservation journal, durable exact raw outbox, receipt indexes, and derived rankings. ROD retains complete published, confirmed qualifying receipts as the independent ledger.
- **Optional future concept:** Replace operational persistence/indexing with OSG and a Cloudflare-compatible adapter using its GraphPort architecture. Durable Objects with SQLite or a separately hosted Node.js OSG service with persistent LanceDB are future possibilities only.
- Current OSG's portable core/contracts may be reusable, but its native LanceDB/filesystem adapter is **not a drop-in Cloudflare Worker dependency**. New storage semantics must preserve append-only history, atomic head compare-and-swap, idempotency, and reliable recovery. A graph alone does not replace the operational transaction journal or efficient ranking projections without additional application logic.
- **Design invariant across both backends:** The game, OpenSpeX Receipt bytes, independent verification, ROD publication and leaderboard calculation must remain behaviorally unchanged. Operational queries and writes should be isolated behind an appropriately small storage boundary **when implementing the planned Supabase layer**; do not write the OSG adapter or migration machinery now.
- **MVP impact:** **Supabase is not removed.** No Node application, Cloudflare Containers, LanceDB deployment, Durable Object, OSG adapter, or migration workflow is required for launch.

## D5 — Authorized revision and precedence

The [task plan](../tasks/plan.md) was already normative, superseding the original snapshot/checkpoint plan. Current authorization explicitly permits revision; the earlier Durable Object decision is not immutable. Revision hd1-plan-2 incorporates D1–D4 with Supabase operational ownership through a narrow transactional SQL RPC/storage boundary, not a new backend service or launch Durable Object. The delta records rationale, not a second implementation contract.

The normative [issuer contract](../tasks/plan.md#7-issuer-state-machine-ownership-and-failure-recovery) requires atomic row locking/CAS, immutable idempotency, serial single-app-key issuance, no database transaction held across signing/network, exact raw persistence before broadcast and SAME-byte uncertain retries. Expiring preparation cannot authorize a stale signer: a non-expiring signing barrier prevents automatic takeover after signing might have begun and fails closed on unresolved ownership/outbox state.

Walletless play, local actual move evidence, local-only practice/assisted/non-improving runs, lifetime OR weekly improvement, local player signing without a player transaction, independent Worker replay, immediate application-WIF broadcast of complete application-signed receipts, and independent weekly ranking from CONFIRMED receipts without Supabase remain required. Rewards remain future; no snapshot/hash-only replacement. P1 capacity remains unresolved. Restricted E1 deployment gathers live evidence; later public-use availability is gated on its results, never the reverse.

**Action now:** Documentation reconciliation only. No implementation, deployment, broadcast, standard approval or frozen OSG specification change. Optional OSG/codecs are not launch blockers.
