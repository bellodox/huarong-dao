-- D6 additive migration: one canonical confirmation + reconciled lineage permits one successor.
-- Six confirmations still finalize rankings (hd1_receipts); twelve still close weeks (reconstruction).
-- Never drops claims, raw outbox, receipts or reservations. Existing ACLs survive CREATE OR REPLACE.
-- Applying it pauses issuance until an authenticated rebuild recomputes state under these rules.
-- Invalidate observations/leases obtained before migration. Apply the whole migration atomically.
begin;
update public.hd1_coordinator set paused=true,revision=revision+1,snapshot=jsonb_set(snapshot,'{stale}','true') where singleton;

-- Only outstanding claims share an exclusive slot. Historical included receipts may coexist
-- with an already admitted improvement after a six-to-five confirmation demotion.
-- Included name/best/week reservations remain enforced by serialized admission below.
drop index if exists public.hd1_active_claim;
create unique index hd1_active_claim on public.hd1_claims(player,layout,epoch)
  where state in ('queued','unsigned_preparing','signing_started','signing_unknown','signed_persisted','broadcast_pending','broadcast_unknown','observed_unconfirmed');

create or replace function public.hd1_rpc(operation text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; q public.hd1_claims%rowtype;
  lifetime integer; weekly integer; bound_name text; rate public.hd1_rates%rowtype;
  -- Exact signed transactions not yet observed in the canonical chain: at most one may exist.
  unconfirmed constant text[]:=array['signing_started','signing_unknown','signed_persisted','broadcast_pending','broadcast_unknown','observed_unconfirmed'];
  -- Failed-closed reconciliation states: no preparation or signing until resolved.
  unreconciled constant text[]:=array['reorged','conflicted','failed_closed'];
  released constant text[]:=array['not_improved','cancelled','epoch_changed','rejected','confirmed'];
  missing_lineage jsonb;
begin
  select * into c from public.hd1_coordinator where singleton for update;
  if operation='rate' then
    -- Ten-minute retention, pruned on every admission attempt (including rejections).
    -- Idle installations need operator-scheduled deletion for a wall-clock erasure SLA.
    delete from public.hd1_rates where started < clock_timestamp()-interval '10 minutes';
    select * into rate from public.hd1_rates where bucket=payload->>'bucket' for update;
    if not found or rate.started < clock_timestamp()-interval '60 seconds' then
      insert into public.hd1_rates values(payload->>'bucket',clock_timestamp(),1)
        on conflict(bucket) do update set started=excluded.started,count=1;
    elsif rate.count>=(case when rate.bucket='global' then 60 else 10 end) then return jsonb_build_object('code','rate_limited');
    else update public.hd1_rates set count=count+1 where bucket=rate.bucket; end if;
    return '{"code":"ok"}';
  end if;
  if operation='read' then
    return jsonb_build_object('coordinator',to_jsonb(c),'claims',coalesce((select jsonb_agg(to_jsonb(t)) from public.hd1_claims t),'[]'::jsonb));
  end if;
  select * into q from public.hd1_claims where id=payload->>'id' for update;
  if operation='admit' then
    if q.id is not null then
      if q.bytes<>payload->>'bytes' then return '{"code":"idempotency_conflict"}'; end if;
      if q.state<>'not_improved' or q.evaluation_revision=c.revision then return to_jsonb(q); end if;
    end if;
    if c.paused then return '{"code":"reconciliation_required"}'; end if;
    if (payload->>'epoch')::bigint is distinct from c.epoch then return '{"code":"epoch_changed"}'; end if;
    -- Included-but-unfinalized receipts (journaled or reconstructed) keep name and best reservations.
    select nickname into bound_name from (
      select nickname,0 as priority,height as ordering from public.hd1_receipts where player=payload->>'player'
      union all select p.nickname,1,p.height from jsonb_to_recordset(coalesce(c.snapshot->'pending','[]'::jsonb)) as p(player text,nickname text,height bigint) where p.player=payload->>'player'
      union all select nickname,2,0 from public.hd1_claims where player=payload->>'player' and state not in ('not_improved','cancelled','epoch_changed','rejected')
    ) names order by priority,ordering limit 1;
    if bound_name is not null and bound_name<>payload->>'nickname' then return '{"code":"name_conflict"}'; end if;
    select min(moves),min(moves) filter(where epoch=c.epoch) into lifetime,weekly from (
      select moves,epoch from public.hd1_receipts where player=payload->>'player' and layout=payload->>'layout'
      union all select p.moves,p.epoch from jsonb_to_recordset(coalesce(c.snapshot->'pending','[]'::jsonb)) as p(player text,layout text,moves integer,epoch bigint)
        where p.player=payload->>'player' and p.layout=payload->>'layout'
      union all select moves,coalesce(actual_epoch,epoch) from public.hd1_claims where player=payload->>'player' and layout=payload->>'layout'
        and state<>all(released)
    ) bests;
    if not ((payload->>'moves')::integer<coalesce(lifetime,2147483647) or (payload->>'moves')::integer<coalesce(weekly,2147483647)) then
      insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
      values(payload->>'id',payload->>'bytes',payload->>'player',payload->>'nickname',payload->>'layout',(payload->>'epoch')::bigint,(payload->>'moves')::integer,(payload->>'points')::integer,'not_improved',c.revision)
      on conflict(id) do update set evaluation_revision=c.revision,state='not_improved' returning * into q;
      return to_jsonb(q);
    end if;
    if (select count(*) from public.hd1_claims where state in ('queued','unsigned_preparing'))>=64 then return '{"code":"queue_full"}'; end if;
    if exists(select 1 from public.hd1_claims where player=payload->>'player' and layout=payload->>'layout' and coalesce(actual_epoch,epoch)=c.epoch and state<>all(released)) then return '{"code":"queue_full"}'; end if;
    update public.hd1_coordinator set revision=revision+1 where singleton returning * into c;
    insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
    values(payload->>'id',payload->>'bytes',payload->>'player',payload->>'nickname',payload->>'layout',(payload->>'epoch')::bigint,(payload->>'moves')::integer,(payload->>'points')::integer,'queued',c.revision)
    on conflict(id) do update set state='queued',evaluation_revision=c.revision returning * into q;
    return to_jsonb(q);
  end if;
  if operation='halt' then
    update public.hd1_coordinator set paused=true,revision=revision+1,snapshot=jsonb_set(snapshot,'{stale}','true') where singleton returning * into c;
    return to_jsonb(c);
  end if;
  if operation='rebuild' then
    if not c.paused or c.revision is distinct from (payload->>'revision')::bigint then return '{"code":"stale_state"}'; end if;
    if jsonb_typeof(payload->'snapshot'->'receipts') is distinct from 'array'
      or jsonb_typeof(coalesce(payload->'snapshot'->'pending','[]'::jsonb)) is distinct from 'array' then return '{"code":"invalid_snapshot"}'; end if;
    -- Remember removed canonical operations even when this installation never journaled them.
    -- Keep the original exact raw evidence supplied by reconstruction; repeated rebuilds cannot
    -- silently forget an orphan and authorize a competing spend after restart.
    select coalesce(jsonb_agg(old.value),'[]'::jsonb) into missing_lineage from (
      select distinct on (value->>'txid') value from jsonb_array_elements(
        coalesce(c.snapshot->'lineage',c.snapshot->'receipts','[]'::jsonb)||
        coalesce(c.snapshot->'pending','[]'::jsonb)||coalesce(c.snapshot->'reorgedLineage','[]'::jsonb))
      order by value->>'txid', (value ? 'raw') desc
    ) old where not exists(select 1 from jsonb_array_elements(
      coalesce(payload->'snapshot'->'lineage',payload->'snapshot'->'receipts','[]'::jsonb)||
      coalesce(payload->'snapshot'->'pending','[]'::jsonb)) current where current->>'txid'=old.value->>'txid');
    -- Replace ONLY the derived six-confirmation index; never remove claims/raw outbox/journal.
    delete from public.hd1_receipts;
    insert into public.hd1_receipts
      select id,txid,player,nickname,layout,epoch,moves,points,height,transaction_index,output_index,receipt
      from jsonb_to_recordset(payload->'snapshot'->'receipts') as r(id text,txid text,player text,nickname text,layout text,epoch bigint,moves integer,points integer,height bigint,transaction_index integer,output_index integer,receipt text);
    -- An exact unobserved spend remains a valid outstanding operation only while it still spends
    -- the authenticated head (or registers an empty lineage). Otherwise it can never extend the
    -- lineage: fail closed as conflicted, never re-sign, rebroadcast or take over its reservations.
    update public.hd1_claims t set state='conflicted'
      where t.raw is not null and t.state=any(unconfirmed)
        and not exists(select 1 from public.hd1_receipts r where r.txid=t.txid)
        and not exists(select 1 from jsonb_to_recordset(coalesce(payload->'snapshot'->'pending','[]'::jsonb)) as p(txid text) where p.txid=t.txid)
        and not coalesce(case when payload->>'head' is null then t.prepared->>'operation'='register'
          else exists(select 1 from jsonb_array_elements(coalesce(t.prepared->'inputs','[]'::jsonb)) i where (i->>'txid')||':'||(i->>'index')=payload->>'head') end,false);
    update public.hd1_claims t set state='reorged',confirmations=0 where t.state in ('confirmed','included')
      and not exists(select 1 from public.hd1_receipts r where r.txid=t.txid)
      and not exists(select 1 from jsonb_to_recordset(coalesce(payload->'snapshot'->'pending','[]'::jsonb)) as p(txid text) where p.txid=t.txid);
    update public.hd1_claims t set state='confirmed',actual_epoch=r.epoch,confirmations=(payload->'snapshot'->>'height')::integer-r.height+1
      from public.hd1_receipts r where r.txid=t.txid and t.raw is not null;
    -- One through five canonical confirmations: included, reconciled, not finalized.
    update public.hd1_claims t set state='included',actual_epoch=p.epoch,confirmations=p.confirmations
      from jsonb_to_recordset(coalesce(payload->'snapshot'->'pending','[]'::jsonb)) as p(txid text,epoch bigint,confirmations integer)
      where p.txid=t.txid and t.raw is not null;
    -- Unsigned old-week claims need fresh player consent/signature, not mutation of w.
    update public.hd1_claims set state='epoch_changed',prepared=null where state in ('queued','unsigned_preparing') and epoch<>(payload->>'epoch')::bigint;
    update public.hd1_coordinator set revision=revision+1,epoch=(payload->>'epoch')::bigint,head=payload->>'head',
      active=case when exists(select 1 from public.hd1_claims where id=c.active and state in ('confirmed','included','epoch_changed')) then null else c.active end,
      paused=jsonb_array_length(missing_lineage)>0 or exists(select 1 from public.hd1_claims where state=any(unreconciled)),
      snapshot=jsonb_set(payload->'snapshot','{reorgedLineage}',missing_lineage) where singleton returning * into c;
    return to_jsonb(c);
  end if;
  if operation='cancel' then
    if q.state not in ('queued','unsigned_preparing','not_improved') then return '{"code":"barrier_locked"}'; end if;
    if q.state='unsigned_preparing' and (q.owner is distinct from payload->>'owner' or q.generation is distinct from (payload->>'generation')::bigint) then return '{"code":"stale_owner"}'; end if;
    update public.hd1_claims set state='cancelled',prepared=null,expires=null where id=q.id returning * into q;
    update public.hd1_coordinator set revision=revision+1,active=case when active=q.id then null else active end where singleton;
    return to_jsonb(q);
  end if;
  -- Durable global guards independent of the active slot: a reorged/conflicted spend halts issuance,
  -- and no successor is prepared or signed while another exact spend is unobserved on chain.
  if operation in ('prepare','begin') then
    if exists(select 1 from public.hd1_claims where state=any(unreconciled)) then
      update public.hd1_coordinator set paused=true,revision=revision+1,snapshot=jsonb_set(snapshot,'{stale}','true') where singleton;
      return '{"code":"reconciliation_required"}';
    end if;
    if exists(select 1 from public.hd1_claims where id is distinct from q.id and state=any(unconfirmed)) then return '{"code":"signer_busy"}'; end if;
  end if;
  if operation='prepare' then
    if c.paused then return '{"code":"reconciliation_required"}'; end if;
    -- Only an unsigned lease may expire; the signing barrier never does.
    if c.active is not null then
      update public.hd1_claims set state='queued',owner=null,prepared=null,expires=null
        where id=c.active and state='unsigned_preparing' and expires<clock_timestamp();
      if found then update public.hd1_coordinator set active=null,revision=revision+1 where singleton returning * into c; end if;
    end if;
    if c.active is not null then return '{"code":"signer_busy"}'; end if;
    if coalesce(length(payload->>'owner'),0)<1 then return '{"code":"stale_owner"}'; end if;
    select * into q from public.hd1_claims where id=payload->>'id' for update;
    if q.id is null then return '{"code":"invalid_state"}'; end if;
    if q.state<>'queued' then return '{"code":"invalid_state"}'; end if;
    if (payload->>'revision')::bigint is distinct from c.revision or (payload->>'epoch')::bigint is distinct from c.epoch or payload->>'head' is distinct from c.head then return '{"code":"stale_state"}'; end if;
    if jsonb_typeof(payload->'prepared'->'inputs') is distinct from 'array' or jsonb_array_length(payload->'prepared'->'inputs')<1 then return '{"code":"funds_unavailable"}'; end if;
    update public.hd1_coordinator set active=q.id,generation=generation+1,revision=revision+1 where singleton returning * into c;
    update public.hd1_claims set state='unsigned_preparing',owner=payload->>'owner',generation=c.generation,
      expires=clock_timestamp()+interval '30 seconds',prepared=payload->'prepared',evaluation_revision=c.revision where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  -- Immutable finalize readback remains idempotent after this predecessor releases the global slot.
  -- This branch never mutates and still authenticates the original ownership generation.
  if operation='finalize' and q.raw is not null then
    if q.owner is distinct from payload->>'owner' or q.generation is distinct from (payload->>'generation')::bigint then return '{"code":"stale_owner"}'; end if;
    if q.raw is distinct from payload->>'raw' or q.txid is distinct from payload->>'txid' or q.receipt is distinct from payload->>'receipt' then return '{"code":"idempotency_conflict"}'; end if;
    return to_jsonb(q);
  end if;
  if operation in ('begin','finalize','broadcast') then
    if q.id is null or q.id is distinct from c.active or q.owner is distinct from payload->>'owner' or q.generation is distinct from (payload->>'generation')::bigint then return '{"code":"stale_owner"}'; end if;
  end if;
  if operation='begin' then
    if c.paused or q.state<>'unsigned_preparing' or q.expires<=clock_timestamp() then return '{"code":"stale_owner"}'; end if;
    if (payload->>'revision')::bigint is distinct from c.revision or payload->>'head' is distinct from c.head then return '{"code":"stale_state"}'; end if;
    if (payload->>'epoch')::bigint is distinct from c.epoch or q.epoch<>c.epoch then
      update public.hd1_claims set state='epoch_changed',prepared=null where id=q.id;
      update public.hd1_coordinator set active=null,revision=revision+1 where singleton;
      return '{"code":"epoch_changed"}';
    end if;
    if payload->'prepared' is distinct from q.prepared then return '{"code":"stale_state"}'; end if;
    select min(moves),min(moves) filter(where epoch=c.epoch) into lifetime,weekly from (
      select moves,epoch from public.hd1_receipts where player=q.player and layout=q.layout
      union all select p.moves,p.epoch from jsonb_to_recordset(coalesce(c.snapshot->'pending','[]'::jsonb)) as p(player text,layout text,moves integer,epoch bigint)
        where p.player=q.player and p.layout=q.layout
      union all select moves,coalesce(actual_epoch,epoch) from public.hd1_claims where id<>q.id and player=q.player and layout=q.layout and state<>all(released)
    ) bests;
    if not (q.moves<coalesce(lifetime,2147483647) or q.moves<coalesce(weekly,2147483647)) then
      update public.hd1_claims set state='not_improved',prepared=null where id=q.id;
      update public.hd1_coordinator set active=null,revision=revision+1 where singleton returning * into c;
      update public.hd1_claims set evaluation_revision=c.revision where id=q.id returning * into q;
      return to_jsonb(q);
    end if;
    update public.hd1_claims set state='signing_started',expires=null where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  if operation='finalize' then
    if q.state<>'signing_started' then return '{"code":"barrier_locked"}'; end if;
    if (payload->>'raw' ~ '^([a-f0-9]{2})+$') is distinct from true or (payload->>'txid' ~ '^[a-f0-9]{64}$') is distinct from true or payload->>'receipt' is null then return '{"code":"malformed"}'; end if;
    if length(payload->>'raw')>=20000 or octet_length(payload->>'receipt')>2048 then return '{"code":"payload_too_large"}'; end if;
    update public.hd1_claims set state='signed_persisted',raw=payload->>'raw',txid=payload->>'txid',receipt=payload->>'receipt',retry_at=clock_timestamp() where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  if operation='broadcast' then
    if c.paused then return '{"code":"reconciliation_required"}'; end if;
    if q.raw is null then return '{"code":"barrier_locked"}'; end if;
    -- An included/confirmed/reorged spend is reconciled from chain, never rebroadcast here.
    if q.state not in ('signed_persisted','broadcast_pending','broadcast_unknown') then return '{"code":"invalid_state"}'; end if;
    if q.attempts>=4 or q.retry_at>clock_timestamp() then return '{"code":"retry_later"}'; end if;
    -- Claim one attempt durably BEFORE fetch; a timeout retains the same raw bytes.
    update public.hd1_claims set state='broadcast_unknown',attempts=attempts+1,
      retry_at=clock_timestamp()+make_interval(secs=>case attempts when 0 then 5 when 1 then 30 else 120 end)
      where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  raise exception 'unsupported_operation';
end $$;
commit;
