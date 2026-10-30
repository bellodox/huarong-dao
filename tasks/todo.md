# Execution checklist — hd1-plan-3 design

## Authorized live completion extension — 2026-10-30

The [current extension](plan.md#14-live-public-leaderboard-execution-extension) supersedes older implementation/policy stops, selects experimental hd2 ranked ceilings of 10 times each frozen optimum (820–1260 moves) and replaces human confirmation checkpoints with autonomous evidence checks. Preserve hd1 semantics and unlimited complete local paths; implementation must prove the complete signed 2,048-byte bound. Historical unchecked items below remain carried scope, not silently completed. The original planning-only boundary is historical; implementation and local validation are complete, while hosted/funded acceptance remains open; secret reads, pushes/deployment and unspecified spending remain excluded.

Ordered slices, dependencies, at most three acceptance criteria each and actual baseline test commands are in the plan. Implementation/local checks are distinguished from external acceptance below; current completion/review evidence belongs only in the [handoff](../tests/release-evidence.md).

- [x] L1: Versioned hd2 policy, canonical signatures/capacity proof and browser path; preserve hd1, eleven ranked ceilings, three practice exclusions and full local evidence. Dependencies: current local baseline.
- [x] L2: Existing SpaceXpanse API preparation/live read-only validation and stable-tip count/page history acquisition; explicit provider trust, no invented snapshot token or consensus proof. Dependencies: L1; default https://api.spacexpanse.org:1234, no added node/service/provider.
- [x] L3: Explicit production issuer using server-only ROD_APP_WIF and existing Supabase/HMAC bindings; bounded scheduled recovery/reconciliation, distinct first registration, pinned established bootstrap/name/marker, exact outbox/signing barrier and one global unconfirmed. Dependencies: L1–L2; retired ROD_EXPERIMENT_ISSUER_WIF remains ignored and never injected.
- [x] LC1 after L1–L3: Aggregate build/core tests and contract/provider-evidence checkpoint; preserve one-confirmation reconciled successor, six final and twelve weekly semantics. No hosted/live pass inferred.
- [ ] L4: Hosted Supabase concurrent-session/migration/permission checks (only missing complete atomic migrations 001 → 002 → 003 → [004](../supabase/migrations/004_finite_publication.sql); runtime schema readiness through 004) and Worker routing/runtime/scheduled acceptance. Dependencies: L3 plus actual access and separate deployment permission where required; unavailable operations stay unchecked.
- [ ] L5: Real consented registration/update, exact-byte recovery, canonical confirmations and independent no-Supabase ranking rebuild with hosted BG/EN browser flow. Dependencies: L4, provider validation and pinned/funded/spend-authorized live prerequisites; source/fixtures do not pass E1.
- [x] LC2 boundary assessment: Local code readiness is separate from blocked hosted/funded-live acceptance; exact remaining prerequisites are recorded in the handoff. L4–L5 acceptance remains unchecked.
- [x] L6: Code Simplifier on completed implementation; preserve contracts and rerun affected checks/build/core/parity. Dependencies: L1–L5 implementation complete with external gaps isolated.
- [x] L7: Independent Test Engineer validates completed implementation and concrete profile/provider/scheduler/SQL/browser risks, actual command exits/counts and evidence limits. Dependencies: L6 and all implementation complete; fix failures before reviews.
- [x] L8: Final targeted security and Code Reviewer results supplied by parent after fixes/local regression; scope and verdict limits recorded only in the handoff. Later substantive changes need relevant revalidation/review.
- [x] LC3 after L6–L8: Final test/review evidence reconciled with unresolved live criteria; approval never substitutes for actual live acceptance.
- [x] L9: Durable docs reconciled before L8; parent-authorized executor completed factual/OSG closeout on the parent's behalf. Persistence evidence belongs only in the handoff; no commit/push/deployment implied.

Operator acceptance uses migration 004's readiness capability revision 4 (003-only fails closed before publisher job/preparation/signing and HTTP availability). Shared value-aware funding authenticates at most 12 candidates/selects at most nine inputs inside the 36-fetch tick budget. Continue finite work only with the returned immutable scope ID and optional 1–10 ticks; no new budgets, queue widening or counter reset. Ordinary cron remains fenced even for scoped reconciliation. The [runbook sequence](../docs/cloudflare-deployment.md#read-only-versus-finite-funded-acceptance) covers sync, lost responses and canonical confirmations through confirmed ranking; actual acceptance remains unchecked above.

Carried mapping: unresolved ranked-policy implementation → L1; E1 and T10/C5 → L2/L4/L5; public availability and final readiness → L3–L9. Executable-packaging validation remains conditional/open outside this minimum live path. Older “no ceiling selected” and “no enablement authorized” statements below describe their historical scope; they do not veto the latest authorization or grant excluded external permissions.

## D5–D7 follow-up

The [combined delta](../docs/Huarong_Dao_MVP_Decision_Delta_2026-10-29-2.md) supersedes conflicting earlier requirements. Checked T1–T12 items below describe the prior local implementation, not automatic evidence for these additions. Current status remains in the [handoff](../tests/release-evidence.md#d7d6-current-local-scope).

- [x] Select/publish/implement experimental hd2 inclusive 10× optimum ceilings for eleven ranked layouts, aligned across browser, verification and reconstruction; test signed capacity and version boundaries while preserving hd1.
- [x] Implement local one-confirmation reconciled successor eligibility with durable included state/retained lineage; six-confirmation rankings/twelve-confirmation close unchanged. Local validation and live limits are in the handoff.
- [x] Produce shared self-contained relay with thin Worker and direct non-listening Node CLI; executor-reported parity/offline/no-project-dependency probes are in the handoff.
- [ ] Test executable packaging when implemented; no executable distribution exists.
- [x] Write [Windows deployment guide](../docs/cloudflare-deployment.md) for disabled/static and optional read-only modes, migration order and rollback; no remote action performed.
- [x] Complete affected local implementation/validation and scoped final reviews; see the [authoritative closeout](../tests/release-evidence.md#d7d6-current-local-scope). That approval is historical only; experimental runtime publication is now implemented under §14. E1, hosted validation and separate public-use gates remain open.

The [normative plan](plan.md) defines the contracts. Later explicit user instructions authorize experimental implementation/local validation. This checklist distinguishes local evidence from unavailable live checks. **Current completion, review scope and remaining gaps are centralized in the [execution handoff](../tests/release-evidence.md)**; the parent owns final reviews and memory persistence.

## Blocking decisions

- [x] A0: Explicit experimental T1–T12 execution/local-validation authorization received; no production change, commit or push authorization.
- [x] P1 investigation: actual-path encoding and explicit final 2,048-byte publication bound tested and documented in the [plan status](plan.md#1-status-authority-and-scope). No arbitrary 1,536-action cap; unlimited local play retained. This is not human public-policy approval.
- [ ] E1 access: configured target chain, pinned bootstrap, disposable limited-funded app wallet, spend envelope and deployment/broadcast access are not established. No live experiment executed.

## Ordered work and checkpoints

Checked implementation items mean locally implemented and tested, not deployed; final scoped review evidence is linked in the handoff.

- [x] T1: Public asset/config alignment and initial QA paths.
- [x] T2/C1: All five QA paths, installed pinned local tooling and local-only regressions.
- [x] T3: Exact successful single-cell evidence, reset/assistance isolation and weekly-only candidate retention.
- [x] T4/C2 local: Player/app signatures, actual 1,536-move and exact-limit 1,722-move receipts; opt-in identity continuity.
- [x] T5: Independent Worker replay/derived points and pre-admission rejection tests.
- [x] T6/C3 local: SQL atomic decisions, fencing, signing barrier, immutable outbox and disk restart tests. Hosted PostgreSQL concurrent-session validation remains external.
- [x] T7: Register/update serialization and persisted-before-fetch/same-byte retries under fixture transport.
- [x] T8/C4 local: Server-only SQL boundary, atomic derived rebuild, journal retention and outage tests. Hosted Supabase/PostgREST not tested.
- [x] T9 local: Authenticated raw-history fixture reconstruction and independent Python oracle, boundary/reorg/external-spend tests.
- [ ] T10/C5 live: Blocked by absent configured/funded live experiment and unverified funded end-to-end and exhaustive provider completeness. Source/fixtures do not satisfy E1.
- [x] T11 local: Disabled production UI and EN/BG workerd fixture flow implemented/tested. Public-use gate remains closed.
- [x] T12/C6 local: Release evidence, rollback and scoped review closeout recorded in the [authoritative handoff](../tests/release-evidence.md); parent-authorized proxy records final persistence there. No deployment inferred.

## Planning-only completion

Historical items below describe prior planning, not implementation. Parent-reported independent Code Reviewer verdict: APPROVE documentation reconciliation only, no issues/corrections; 101 active local links/fragments/line bounds checked with zero errors. This does not approve implementation, runtime safety, deployment or public use. Parent owns final task status; final OSG persistence is separately authorized.

- [x] No pre-existing task directory/incomplete plan overwritten.
- [x] Frozen design and dependency-sized packets saved; historical prior design retained.
- [x] Documentation validation and inherited whitespace-check limitation recorded in [§13](plan.md#13-planning-validation-record).
- [x] Parent handoff prepared with actual evidence and remaining gates; final authorized OSG persistence results are returned to the parent, not duplicated here.
