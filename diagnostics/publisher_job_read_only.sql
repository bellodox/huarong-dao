-- Huarong Dao: read-only job RPC access and wrapper inspection.
-- Safe to run in Supabase SQL Editor. Does not acquire a job or mutate state.
SELECT
  p.oid::regprocedure::text AS function_signature,
  pg_get_userbyid(p.proowner) AS function_owner,
  p.prosecdef AS security_definer,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('hd1_rpc', 'hd1_rpc_v8', 'hd1_rpc_v6', 'hd1_completed_original')
ORDER BY p.proname;

SELECT
  r.ready, r.code, r.owner,
  r.expires, r.checked_at,
  c.paused, c.snapshot->>'stale' AS snapshot_stale,
  r.finite_scope->>'mode' AS publication_mode,
  r.finite_scope->>'transactions' AS transactions_used,
  r.finite_scope->>'max_transactions' AS transactions_allowed
FROM public.hd1_runtime r
CROSS JOIN public.hd1_coordinator c
WHERE r.singleton AND c.singleton;
