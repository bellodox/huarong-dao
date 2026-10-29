-- Experimental server-only operational state. Confirmed receipts remain independently replayable.
create table public.hd1_coordinator (
  singleton boolean primary key default true check(singleton), revision bigint not null default 0,
  epoch bigint not null default 0, head text, active text, generation bigint not null default 0,
  paused boolean not null default true, snapshot jsonb not null default '{"rows":[],"pending":[],"stale":true}'
);
insert into public.hd1_coordinator(singleton) values(true);
create table public.hd1_claims (
  id text primary key check(id ~ '^[a-f0-9]{64}$'), bytes text not null,
  player text not null check(player ~ '^(02|03)[a-f0-9]{64}$'), nickname text not null,
  layout text not null, epoch bigint not null, moves integer not null check(moves>0), points integer not null check(points>=0),
  state text not null, evaluation_revision bigint not null, owner text, generation bigint,
  expires timestamptz, prepared jsonb, raw text, txid text, receipt text,
  attempts integer not null default 0, retry_at timestamptz, actual_epoch bigint, confirmations integer not null default 0,
  check ((raw is null and txid is null) or (raw ~ '^([a-f0-9]{2})+$' and txid ~ '^[a-f0-9]{64}$'))
);
create unique index hd1_active_claim on public.hd1_claims(player,layout,epoch)
  where state in ('queued','unsigned_preparing','signing_started','signing_unknown','signed_persisted','broadcast_pending','broadcast_unknown','observed_unconfirmed');
create table public.hd1_receipts (
  id text not null, txid text not null, player text not null, nickname text not null,
  layout text not null, epoch bigint not null, moves integer not null, points integer not null,
  height bigint not null, transaction_index integer not null, output_index integer not null, receipt text not null,
  primary key(txid,output_index)
);
create table public.hd1_rates (bucket text primary key, started timestamptz not null, count integer not null);
create index hd1_rates_expiry on public.hd1_rates(started);
alter table public.hd1_coordinator enable row level security;
alter table public.hd1_claims enable row level security;
alter table public.hd1_receipts enable row level security;
alter table public.hd1_rates enable row level security;
revoke all on public.hd1_coordinator,public.hd1_claims,public.hd1_receipts,public.hd1_rates from public,anon,authenticated,service_role;

-- One coordinator lock orders all mutations. Each HTTP RPC completes before any network/signing.
create function public.hd1_rpc(operation text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.hd1_coordinator%rowtype; q public.hd1_claims%rowtype;
  lifetime integer; weekly integer; bound_name text; rate public.hd1_rates%rowtype;
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
    select nickname into bound_name from (
      select nickname,0 as priority,height as ordering from public.hd1_receipts where player=payload->>'player'
      union all select nickname,1,0 from public.hd1_claims where player=payload->>'player' and state not in ('not_improved','cancelled','epoch_changed','rejected')
    ) names order by priority,ordering limit 1;
    if bound_name is not null and bound_name<>payload->>'nickname' then return '{"code":"name_conflict"}'; end if;
    select min(moves),min(moves) filter(where epoch=c.epoch) into lifetime,weekly from (
      select moves,epoch from public.hd1_receipts where player=payload->>'player' and layout=payload->>'layout'
      union all select moves,epoch from public.hd1_claims where player=payload->>'player' and layout=payload->>'layout'
        and state not in ('not_improved','cancelled','epoch_changed','rejected','confirmed')
    ) bests;
    if not ((payload->>'moves')::integer<coalesce(lifetime,2147483647) or (payload->>'moves')::integer<coalesce(weekly,2147483647)) then
      insert into public.hd1_claims(id,bytes,player,nickname,layout,epoch,moves,points,state,evaluation_revision)
      values(payload->>'id',payload->>'bytes',payload->>'player',payload->>'nickname',payload->>'layout',(payload->>'epoch')::bigint,(payload->>'moves')::integer,(payload->>'points')::integer,'not_improved',c.revision)
      on conflict(id) do update set evaluation_revision=c.revision,state='not_improved' returning * into q;
      return to_jsonb(q);
    end if;
    if (select count(*) from public.hd1_claims where state in ('queued','unsigned_preparing'))>=64 then return '{"code":"queue_full"}'; end if;
    if exists(select 1 from public.hd1_claims where player=payload->>'player' and layout=payload->>'layout' and epoch=c.epoch and state not in ('not_improved','cancelled','epoch_changed','rejected','confirmed')) then return '{"code":"queue_full"}'; end if;
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
    if jsonb_typeof(payload->'snapshot'->'receipts') is distinct from 'array' then return '{"code":"invalid_snapshot"}'; end if;
    -- Replace ONLY the derived confirmed index; never remove claims/raw outbox/journal.
    delete from public.hd1_receipts;
    insert into public.hd1_receipts
      select id,txid,player,nickname,layout,epoch,moves,points,height,transaction_index,output_index,receipt
      from jsonb_to_recordset(payload->'snapshot'->'receipts') as r(id text,txid text,player text,nickname text,layout text,epoch bigint,moves integer,points integer,height bigint,transaction_index integer,output_index integer,receipt text);
    update public.hd1_claims t set state='reorged',confirmations=0 where t.state='confirmed' and not exists(select 1 from public.hd1_receipts r where r.txid=t.txid);
    update public.hd1_claims t set state='confirmed',actual_epoch=r.epoch,confirmations=(payload->'snapshot'->>'height')::integer-r.height+1
      from public.hd1_receipts r where r.txid=t.txid and t.raw is not null;
    -- Unsigned old-week claims need fresh player consent/signature, not mutation of w.
    update public.hd1_claims set state='epoch_changed',prepared=null where state in ('queued','unsigned_preparing') and epoch<>(payload->>'epoch')::bigint;
    update public.hd1_coordinator set revision=revision+1,epoch=(payload->>'epoch')::bigint,head=payload->>'head',
      active=case when exists(select 1 from public.hd1_claims where id=c.active and state in ('confirmed','epoch_changed')) then null else c.active end,
      -- Reconstructed pending lineage owns the global barrier even without a local journal.
      paused=jsonb_array_length(coalesce(payload->'snapshot'->'pending','[]'::jsonb))>0
        or exists(select 1 from public.hd1_claims where state='reorged'),snapshot=payload->'snapshot' where singleton returning * into c;
    return to_jsonb(c);
  end if;
  if operation='cancel' then
    if q.state not in ('queued','unsigned_preparing','not_improved') then return '{"code":"barrier_locked"}'; end if;
    if q.state='unsigned_preparing' and (q.owner is distinct from payload->>'owner' or q.generation is distinct from (payload->>'generation')::bigint) then return '{"code":"stale_owner"}'; end if;
    update public.hd1_claims set state='cancelled',prepared=null,expires=null where id=q.id returning * into q;
    update public.hd1_coordinator set revision=revision+1,active=case when active=q.id then null else active end where singleton;
    return to_jsonb(q);
  end if;
  -- No preparation, signing or broadcast may bypass a reconstructed pending receipt.
  -- Only a later authenticated rebuild removing pending lineage can release this pause.
  if operation in ('prepare','begin','broadcast') and jsonb_array_length(coalesce(c.snapshot->'pending','[]'::jsonb))>0 then
    update public.hd1_coordinator set paused=true,revision=revision+1,snapshot=jsonb_set(snapshot,'{stale}','true') where singleton;
    return '{"code":"reconciliation_required"}';
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
      union all select moves,epoch from public.hd1_claims where id<>q.id and player=q.player and layout=q.layout and state not in ('not_improved','cancelled','epoch_changed','rejected','confirmed')
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
    if q.raw is not null then
      if q.raw is distinct from payload->>'raw' or q.txid is distinct from payload->>'txid' or q.receipt is distinct from payload->>'receipt' then return '{"code":"idempotency_conflict"}'; end if;
      return to_jsonb(q);
    end if;
    if q.state<>'signing_started' then return '{"code":"barrier_locked"}'; end if;
    if (payload->>'raw' ~ '^([a-f0-9]{2})+$') is distinct from true or (payload->>'txid' ~ '^[a-f0-9]{64}$') is distinct from true or payload->>'receipt' is null then return '{"code":"malformed"}'; end if;
    if length(payload->>'raw')>=20000 or octet_length(payload->>'receipt')>2048 then return '{"code":"payload_too_large"}'; end if;
    update public.hd1_claims set state='signed_persisted',raw=payload->>'raw',txid=payload->>'txid',receipt=payload->>'receipt',retry_at=clock_timestamp() where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  if operation='broadcast' then
    if c.paused then return '{"code":"reconciliation_required"}'; end if;
    if q.raw is null then return '{"code":"barrier_locked"}'; end if;
    if q.attempts>=4 or q.retry_at>clock_timestamp() then return '{"code":"retry_later"}'; end if;
    -- Claim one attempt durably BEFORE fetch; a timeout retains the same raw bytes.
    update public.hd1_claims set state='broadcast_unknown',attempts=attempts+1,
      retry_at=clock_timestamp()+make_interval(secs=>case attempts when 0 then 5 when 1 then 30 else 120 end)
      where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  raise exception 'unsupported_operation';
end $$;
revoke all on function public.hd1_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_rpc(text,jsonb) to service_role;

-- Public pending scans never traverse rejected/cancelled decision history.
create index hd1_public_pending on public.hd1_claims(id)
  where state not in ('confirmed','not_improved','cancelled','rejected','epoch_changed');
create index hd1_receipt_ranking on public.hd1_receipts(player,layout,moves,height,transaction_index,output_index);

-- Shared explicit status whitelist. No raw bytes, receipt, owner or preparation metadata.
create function public.hd1_public_status(q public.hd1_claims) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('status',case when q.state in ('signing_started','signing_unknown') then 'signing_unknown' else q.state end,
    'receipt_id',q.id,'code',q.state,'retryable',q.state in ('queued','broadcast_unknown','broadcast_pending'),
    'provisional_epoch',q.epoch,'actual_epoch',q.actual_epoch,'txid',q.txid,
    'confirmations',q.confirmations,'derived_moves',q.moves,'derived_points',q.points)
$$;
revoke all on function public.hd1_public_status(public.hd1_claims) from public,anon,authenticated,service_role;

-- STABLE uses one MVCC snapshot and cannot mutate. Plain SELECT does not wait on
-- the coordinator row's mutation lock. Public GET must never call hd1_rpc('read').
create function public.hd1_public(operation text,payload jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; page_limit integer:=coalesce((payload->>'limit')::integer,20);
  page_offset integer:=coalesce((payload->>'offset')::integer,0);
  scope text:=coalesce(payload->>'scope','lifetime'); selected_layout text:=payload->>'layout';
begin
  if operation='status' then
    if coalesce(payload->>'id','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_query'; end if;
    select public.hd1_public_status(q) into result from public.hd1_claims q where id=payload->>'id';
    return result;
  end if;
  if operation<>'leaderboard' or page_limit<1 or page_limit>100 or page_offset<0 or page_offset>10000
    or scope not in ('lifetime','week') or (scope='week' and coalesce(payload->>'week','') !~ '^\d{1,10}$')
    or (payload->>'player' is not null and payload->>'player' !~ '^(02|03)[a-f0-9]{64}$')
    or (selected_layout is not null and selected_layout not in ('wings','heng_dao_li_ma','rear_guard','small_obstacle','ambush','fayaa_sideBySide','fayaa_threeRoads','fayaa_peach','fayaa_rain2','fayaa_cannotStop','fayaa_highRisk'))
    then raise exception 'invalid_query'; end if;
  with best as (
    select distinct on (r.player,r.layout) r.player,r.nickname,r.layout,r.moves,r.points,r.id
    from public.hd1_receipts r
    where (scope='lifetime' or r.epoch=(payload->>'week')::bigint)
      and (selected_layout is null or r.layout=selected_layout)
      and (payload->>'player' is null or r.player=payload->>'player')
      and r.layout in ('wings','heng_dao_li_ma','rear_guard','small_obstacle','ambush','fayaa_sideBySide','fayaa_threeRoads','fayaa_peach','fayaa_rain2','fayaa_cannotStop','fayaa_highRisk')
    order by r.player,r.layout,r.moves,r.height,r.transaction_index,r.output_index
  ), players as (
    select player,min(nickname) as nickname,sum(points) as points,count(*) as completed,min(moves) as moves,
      jsonb_object_agg(layout,jsonb_build_object('moves',moves,'points',points,'receipt_id',id)) as bests
    from best group by player
  ), numbered as (
    select *,row_number() over(order by case when selected_layout is not null then moves end asc,
      case when selected_layout is null then points end desc,case when selected_layout is null then completed end desc,player collate "C") as position
    from players
  ), page as (
    select * from numbered order by position limit page_limit+1 offset page_offset
  )
  select jsonb_build_object('rows',coalesce((select jsonb_agg(jsonb_build_object('player',player,'nickname',nickname,'points',points,'completed',completed,'bests',bests) order by position) from page where position<=page_offset+page_limit),'[]'::jsonb),
    'has_more',(select count(*)>page_limit from page),
    'pending',coalesce((select jsonb_agg(public.hd1_public_status(q) order by q.id) from
      (select * from public.hd1_claims where state not in ('confirmed','not_improved','cancelled','rejected','epoch_changed') order by id limit 20) q),'[]'::jsonb),
    'epoch',c.epoch,'snapshot_revision',c.revision,'confirmed_height',c.snapshot->'height','confirmed_hash',c.snapshot->'hash',
    'stale',c.paused or coalesce((c.snapshot->>'stale')::boolean,true)) into result
  from public.hd1_coordinator c where singleton;
  return result;
end $$;
revoke all on function public.hd1_public(text,jsonb) from public,anon,authenticated;
grant execute on function public.hd1_public(text,jsonb) to service_role;
