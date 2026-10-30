-- Additive operational follower. Apply after 001 + 002, as one transaction.
-- Exact signing journals and the non-expiring barrier are never reset by a job lease.
begin;
create table public.hd1_runtime (
  singleton boolean primary key default true check(singleton),
  version bigint not null default 0, config jsonb, bootstrap text, bootstrap_claim text,
  document jsonb not null default '{}', owner text, expires timestamptz,
  checked_at timestamptz, ready boolean not null default false,
  code text not null default 'initial_sync',
  check(bootstrap is null or bootstrap ~ '^[a-f0-9]{64}$')
);
insert into public.hd1_runtime(singleton) values(true);
alter table public.hd1_runtime enable row level security;
revoke all on public.hd1_runtime from public,anon,authenticated,service_role;

-- Preserve the 002 implementation and its ACL boundary; only the wrapper is callable.
alter function public.hd1_rpc(text,jsonb) rename to hd1_rpc_v2;
revoke all on function public.hd1_rpc_v2(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_rpc(operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; r public.hd1_runtime%rowtype;
  q public.hd1_claims%rowtype; result jsonb; halted jsonb;
begin
  -- Same lock order for all old and new operations, including overlapping cron/request work.
  select * into c from public.hd1_coordinator where singleton for update;
  select * into r from public.hd1_runtime where singleton for update;
  if operation='operational' then return to_jsonb(r); end if;
  if operation='job' then
    if coalesce(length(payload->>'owner'),0) not between 1 and 64 then return '{"code":"stale_job"}'; end if;
    if r.owner is not null and r.expires>clock_timestamp() then return '{"code":"job_busy"}'; end if;
    update public.hd1_runtime set owner=payload->>'owner',expires=clock_timestamp()+interval '90 seconds'
      where singleton returning * into r;
    delete from public.hd1_rates where started<clock_timestamp()-interval '10 minutes';
    -- Only unsigned expired preparation may be reclaimed. Never touch signing_started.
    update public.hd1_claims set state='queued',owner=null,prepared=null,expires=null
      where id=c.active and state='unsigned_preparing' and expires<=clock_timestamp();
    if found then update public.hd1_coordinator set active=null,revision=revision+1 where singleton; end if;
    return to_jsonb(r);
  end if;
  if operation in ('initialize','save','synchronize','job_done','job_error') or
    (r.config is not null and operation in ('prepare','begin','broadcast')) then
    if r.owner is distinct from payload->>'job' or r.expires is null or r.expires<=clock_timestamp() then return '{"code":"stale_job"}'; end if;
  end if;
  if operation='initialize' then
    if r.config is not null then
      if r.config is distinct from payload->'config' then return '{"code":"identity_configuration_mismatch"}'; end if;
      return to_jsonb(r);
    end if;
    if jsonb_typeof(payload->'config') is distinct from 'object' or
      coalesce(payload->'config'->>'appKey','') !~ '^0[23][a-f0-9]{64}$' or
      coalesce(payload->'config'->>'markerKey','') !~ '^0[23][a-f0-9]{64}$' or
      coalesce(payload->'config'->'anchor'->>'hash','') !~ '^[a-f0-9]{64}$' then return '{"code":"invalid_configuration"}'; end if;
    -- An existing database head cannot be relabelled as a fresh installation.
    if c.head is not null and payload->>'bootstrap' is null then return '{"code":"bootstrap_pin_required"}'; end if;
    if payload->>'bootstrap_claim' is not null and not exists(select 1 from public.hd1_claims
      where id=payload->>'bootstrap_claim' and txid=payload->>'bootstrap' and raw is not null and prepared->>'operation'='register')
      then return '{"code":"bootstrap_pin_required"}'; end if;
    update public.hd1_runtime set config=payload->'config',bootstrap=payload->>'bootstrap',bootstrap_claim=payload->>'bootstrap_claim',
      document=payload->'document',version=version+1 where singleton returning * into r;
    return to_jsonb(r);
  end if;
  if operation='save' then
    if r.version is distinct from (payload->>'version')::bigint then return '{"code":"stale_state"}'; end if;
    if jsonb_typeof(payload->'document') is distinct from 'object' then return '{"code":"invalid_snapshot"}'; end if;
    update public.hd1_runtime set document=payload->'document',version=version+1,
      ready=false,code='initial_sync' where singleton returning * into r;
    return to_jsonb(r);
  end if;
  if operation='synchronize' then
    if c.revision is distinct from (payload->>'revision')::bigint or r.version is distinct from (payload->>'version')::bigint then return '{"code":"stale_state"}'; end if;
    if c.snapshot->>'hash' is distinct from payload->'snapshot'->>'hash' or coalesce((c.snapshot->>'stale')::boolean,true) or
      c.head is distinct from payload->>'head' or c.epoch is distinct from (payload->>'epoch')::bigint then
      halted:=public.hd1_rpc_v2('halt','{}');
      result:=public.hd1_rpc_v2('rebuild',jsonb_build_object('revision',halted->'revision',
        'head',payload->'head','epoch',payload->'epoch','snapshot',payload->'snapshot'));
      if result ? 'code' then return result; end if;
    end if;
    update public.hd1_runtime set checked_at=clock_timestamp(),ready=not (select paused from public.hd1_coordinator where singleton),
      code=case when (select paused from public.hd1_coordinator where singleton) then 'reconciliation_required' else 'ready' end
      where singleton returning * into r;
    return to_jsonb(r);
  end if;
  if operation='job_error' then
    -- Stable code only: provider payloads, URLs and credentials never enter public diagnostics.
    update public.hd1_runtime set ready=false,code=case when payload->>'code' in
      ('funds_unavailable','bootstrap_pin_required','bootstrap_anchor_required','bootstrap_missing','identity_configuration_mismatch',
       'anchor_mismatch','checkpoint_mismatch','reorg_detected','name_lineage_conflict','history_changed',
       'history_page_gap','history_budget_exceeded','provider_timeout','provider_unavailable',
       'wrong_network','signing_unknown','retry_exhausted','funding_compression_incompatible',
       'invalid_provider_config','initial_sync','unconfirmed_pending','conflict_suspected')
      then payload->>'code' else 'publisher_unavailable' end where singleton returning * into r;
    if not c.paused then
      update public.hd1_coordinator set paused=true,revision=revision+1,
        snapshot=jsonb_set(snapshot,'{stale}','true') where singleton;
    end if;
    return to_jsonb(r);
  end if;
  if operation='job_done' then
    update public.hd1_runtime set owner=null,expires=null where singleton;
    return '{"code":"ok"}';
  end if;
  if operation='next' then
    -- Selection is advisory; prepare/begin and the global 002 fences are authoritative.
    select * into q from public.hd1_claims where id=c.active;
    if q.id is null then select * into q from public.hd1_claims where state='queued' order by evaluation_revision,id limit 1; end if;
    if q.id is null then return 'null'::jsonb; end if;
    return to_jsonb(q);
  end if;
  result:=public.hd1_rpc_v2(operation,payload);
  if operation='finalize' and result->>'raw' is not null and r.config is not null then
    select * into q from public.hd1_claims where id=payload->>'id';
    if q.prepared->>'operation'='register' then
      if r.bootstrap is not null and r.bootstrap<>q.txid then raise exception 'bootstrap_conflict'; end if;
      -- Atomic with exact raw persistence: crash after finalize cannot lose bootstrap identity.
      update public.hd1_runtime set bootstrap=q.txid,bootstrap_claim=q.id where singleton;
    end if;
  end if;
  return result;
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

alter function public.hd1_public(text,jsonb) rename to hd1_public_v2;
revoke all on function public.hd1_public_v2(text,jsonb) from public,anon,authenticated,service_role;
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if operation='readiness' then
    return (select jsonb_build_object('available',r.ready and not c.paused and r.checked_at>statement_timestamp()-interval '3 minutes'
        and (payload->>'appKey' is null or (r.config->>'appKey'=payload->>'appKey' and r.config->>'markerKey'=payload->>'markerKey' and r.config->>'baseUrl'=payload->>'baseUrl')),
      'code',case when r.config is not null and payload->>'appKey' is not null and
        (r.config->>'appKey' is distinct from payload->>'appKey' or r.config->>'markerKey' is distinct from payload->>'markerKey' or r.config->>'baseUrl' is distinct from payload->>'baseUrl')
        then 'identity_configuration_mismatch' when r.ready and r.checked_at<=statement_timestamp()-interval '3 minutes' then 'publisher_stale' else r.code end,
      'trust','provider_anchored','first_registration_policy','bounded_chain_rejected_duplicate',
      'bootstrap_txid',r.bootstrap,'checked_at',r.checked_at)
      from public.hd1_runtime r cross join public.hd1_coordinator c where r.singleton and c.singleton);
  end if;
  return public.hd1_public_v2(operation,payload);
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
commit;
