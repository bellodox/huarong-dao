-- Operator-only safe rollback: disable issuance and RPC access, never erase the signed outbox.
-- Disable Worker public availability first. Reconcile chain/name/input state before any resumption.
begin;
update public.hd1_coordinator set paused=true,revision=revision+1,
  snapshot=jsonb_set(snapshot,'{stale}','true') where singleton;
revoke execute on function public.hd1_rpc(text,jsonb) from service_role;
revoke execute on function public.hd1_public(text,jsonb) from service_role;
commit;
-- Deliberately retain all tables, name/input reservations, player bindings and exact raw bytes.
-- Code rollback cannot undo a broadcast. No automatic reset of signing_started/signing_unknown.
