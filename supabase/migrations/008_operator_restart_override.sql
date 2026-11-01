-- One explicitly authorized experimental administrative retirement, not chain proof.
-- Preserve 007, its service-only boundary, every original journal and finite counter.
begin;
do $migration$
declare definition text; previous text; needle text;
begin
  if to_regprocedure('public.hd1_rpc_v7(text,jsonb)') is not null then
    raise exception 'operator_override_already_installed';
  end if;
  definition:=pg_get_functiondef('public.hd1_rpc(text,jsonb)'::regprocedure);
  needle:='  lifetime integer; weekly integer; valid_job boolean; included jsonb;';
  if strpos(definition,needle)=0 then raise exception 'unexpected_recovery_schema'; end if;
  definition:=replace(definition,needle,needle||E'\n  administrative boolean;');
  needle:='  valid_job:=r.owner is not null and r.owner=payload->>''job'' and r.expires>clock_timestamp();';
  if strpos(definition,needle)=0 then raise exception 'unexpected_recovery_schema'; end if;
  definition:=replace(definition,needle,needle||$patch$
  administrative:=coalesce((case when h.id is null then payload else h.envelope end)->>'retirement_mode'='operator_override_2026_11_01',false);
$patch$);
  needle:='      coalesce(payload->>''conflict_txid'','''') !~ ''^[a-f0-9]{64}$'' or payload->>''conflict_txid''=q.txid or';
  if strpos(definition,needle)=0 then raise exception 'unexpected_recovery_schema'; end if;
  definition:=replace(definition,needle,$patch$
      (not administrative and (coalesce(payload->>'conflict_txid','') !~ '^[a-f0-9]{64}$' or payload->>'conflict_txid'=q.txid)) or
      (administrative and (
        payload->>'scope_id' is distinct from '33e98e66-02a4-4c1f-b96a-0be750e939b7' or
        q.id is distinct from 'cb7919da2141eb641b29f53b4a7fbc641c59a1d69dc0afbbcc84f0ec2d7ee4f3' or
        q.txid is distinct from '40657978880fd5fb38929db8939255dfa3d92e629b04852638047c8d34e5db9f' or
        q.generation is distinct from 1 or payload ? 'conflict_txid' or
        payload->>'max_broadcasts' is distinct from '1' or
        payload->>'max_fee_units' is distinct from '100000' or
        payload->>'max_new_locked_units' is distinct from '1000600' or
        payload->>'retirement_reason' is distinct from 'Explicit experimental operator authority; no confirmed conflict or original inclusion required; original and replacement may still confirm.'
      )) or
$patch$);
  needle:='      if retirement_proof->>''original_txid'' is distinct from q.txid or retirement_proof->>''conflict_txid'' is distinct from h.envelope->>''conflict_txid'' or';
  if strpos(definition,needle)=0 then raise exception 'unexpected_recovery_schema'; end if;
  definition:=replace(definition,needle,$patch$
      if administrative then
        if retirement_proof is distinct from jsonb_build_object(
          'kind','operator_override_2026_11_01','original_txid',q.txid,
          'reason',h.envelope->>'retirement_reason','original_may_confirm',true) or
          payload->>'confirmations' is distinct from '0' or
          coalesce(payload->>'tip_hash','') !~ '^[a-f0-9]{64}$'
          then return '{"code":"invalid_administrative_retirement"}'; end if;
      elsif retirement_proof->>'original_txid' is distinct from q.txid or retirement_proof->>'conflict_txid' is distinct from h.envelope->>'conflict_txid' or
$patch$);
  -- Keep the complete prior wrapper as a revoked compatibility implementation.
  -- New definition retains every unmodified 007 guard and all calls to v6.
  alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v7;
  revoke all on function public.hd1_rpc_v7(text,jsonb) from public,anon,authenticated,service_role;
  execute definition;
end $migration$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;
comment on function public.hd1_rpc(text,jsonb) is '008: one scope/claim/txid-pinned experimental administrative retirement; original and replacement ambiguity retained; no chain-proven conflict asserted';
commit;
