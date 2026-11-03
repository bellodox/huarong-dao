-- Narrow restoration of the intended publisher operational RPC permissions.
-- Apply in Supabase SQL Editor as postgres only if diagnostic shows the entrypoint
-- service_execute=false or service_schema_usage=false.
-- Does NOT touch coordinator pause, publisher jobs, finite scope, claims, fees,
-- recoveries, or ROD signing. Re-running is safe.
BEGIN;

DO $preflight$
DECLARE f oid;
BEGIN
  f := to_regprocedure('public.hd1_rpc(text,jsonb)');
  IF f IS NULL THEN
    RAISE EXCEPTION 'hd1_rpc_entrypoint_not_found';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN
    RAISE EXCEPTION 'unexpected_hd1_rpc_security_invoker';
  END IF;
  IF has_function_privilege('anon',f,'EXECUTE')
    OR has_function_privilege('authenticated',f,'EXECUTE') THEN
    RAISE EXCEPTION 'unexpected_public_rpc_execute_grants';
  END IF;
END
$preflight$;

-- Restore ONLY the service entrypoint. Internal v2-v8 functions stay revoked.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.hd1_rpc(text,jsonb) TO service_role;

DO $postflight$
BEGIN
  IF NOT has_schema_privilege('service_role','public','USAGE')
     OR NOT has_function_privilege('service_role',
          'public.hd1_rpc(text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'publisher_service_role_execute_still_missing';
  END IF;
END
$postflight$;
COMMIT;

SELECT
  has_schema_privilege('service_role','public','USAGE') AS service_schema_usage,
  has_function_privilege('service_role',
    'public.hd1_rpc(text,jsonb)','EXECUTE') AS service_execute;
