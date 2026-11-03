-- Read-only publisher diagnostics. Run in Supabase SQL Editor.
-- No reset, no recovery operation, no RPC invocation, no transaction publication.
SELECT
  clock_timestamp() AS observed_utc,
  r.checked_at AS publisher_last_success,
  clock_timestamp()-r.checked_at AS age,
  r.ready AS last_success_ready,
  r.code AS last_persisted_code,
  c.paused,
  c.snapshot->>'stale' AS snapshot_stale,
  c.snapshot->>'height' AS snapshot_height,
  r.document->'headers'->-1->>'height' AS acquired_last_header,
  r.owner IS NOT NULL AS job_owner_present,
  r.expires AS lease_expiry,
  r.version AS runtime_version,
  c.revision AS coordinator_revision,
  r.finite_scope->>'mode' AS publication_mode,
  r.finite_scope->>'transactions' AS used_transactions,
  r.finite_scope->>'max_transactions' AS max_transactions,
  r.finite_scope->>'broadcasts' AS used_broadcasts,
  r.finite_scope->>'max_broadcasts' AS max_broadcasts,
  h.status AS recovery_state,
  h.completion IS NOT NULL AS recovery_completed,
  public.hd1_completed_original(h.original_id) AS original_archived,
  has_function_privilege('service_role','public.hd1_rpc(text,jsonb)','EXECUTE') AS service_can_invoke_publisher,
  has_function_privilege('service_role','public.hd1_public(text,jsonb)','EXECUTE') AS service_can_read_leaderboard
FROM public.hd1_runtime r
JOIN public.hd1_coordinator c ON c.singleton
JOIN public.hd1_recovery h ON h.singleton
WHERE r.singleton;

-- Permanent archived original is intentionally excluded from new-signing fences.
SELECT state, count(*) AS claims,
  count(*) FILTER(WHERE NOT public.hd1_completed_original(id)) AS active_scope_claims
FROM public.hd1_claims
GROUP BY state ORDER BY state;
