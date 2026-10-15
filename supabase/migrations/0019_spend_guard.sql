-- ---------------------------------------------------------------------------
-- 0019_spend_guard.sql
--
-- A ceiling on what the assistant can spend, enforced before the money is
-- committed rather than counted after it is gone.
--
-- WHY A RESERVATION AND NOT A CHECK
--
-- The obvious version reads the total spent so far, compares it to the limit,
-- and calls the model. Two requests arriving at the same moment both read the
-- same total, both pass, and both spend. With a one dollar cap and a handful of
-- cents a request that hardly matters; with a stuck client firing continuously
-- it is the whole problem, because that is exactly the case where many
-- requests are in flight together.
--
-- So a request books its worst case first, under a lock, and settles for its
-- real cost afterwards. Budget that is in flight is budget that is spent as far
-- as the next request is concerned. The same lock does the rate limit and the
-- duplicate check, because all three are the same question: may this request
-- happen, given everything else that is happening.
--
-- WHAT COUNTS TOWARDS THE LIMIT
--
--   a settled request with a known cost      what it cost
--   a settled request with an unknown cost   its reserved worst case
--   a reservation still in flight            its reserved worst case
--
-- The middle row is the one that matters. A request that failed on the way back
-- was billed and reported nothing, so counting it as zero would let unknown
-- costs walk straight through the ceiling.
--
-- An abandoned reservation, from a function that died before settling, is
-- settled at its worst case rather than forgotten, for the same reason. That is
-- deliberately pessimistic: it may hold budget for a request that cost nothing.
-- Protecting the ceiling is worth more than reclaiming a cent.
-- ---------------------------------------------------------------------------

alter table ai_usage
  add column if not exists state text not null default 'settled'
    check (state in ('reserved', 'settled'));

-- The worst case this request could cost, booked before it ran. Kept after
-- settling, because an unknown actual cost is counted at this figure.
alter table ai_usage
  add column if not exists reserved_micros bigint check (reserved_micros >= 0);

-- When an unsettled reservation stops being believed to be in flight.
alter table ai_usage
  add column if not exists reserved_until timestamptz;

-- One value per press of Ask, so a double click or a retried request cannot be
-- charged twice.
alter table ai_usage
  add column if not exists request_token text;

create unique index if not exists ai_usage_one_per_request
  on ai_usage (owner_id, request_token)
  where request_token is not null;

alter table ai_usage drop constraint if exists reserved_rows_say_how_much;
alter table ai_usage add constraint reserved_rows_say_how_much check (
  state <> 'reserved' or (reserved_micros is not null and reserved_until is not null));

/*
 * 0018's rule, with room for a reservation.
 *
 * A reserved row has no cost yet and that is not a gap in the accounting, it is
 * a request that has not finished. Everything that has finished still has to
 * say why its cost is unknown.
 */
alter table ai_usage drop constraint if exists unknown_cost_says_why;
alter table ai_usage add constraint unknown_cost_says_why check (
  state = 'reserved'
  or cost_micros is not null
  or error is not null
  or note is not null);

/**
 * May this request happen, and if so, book its worst case.
 *
 * Returns one of four answers. Only 'ok' comes with a usage_id, and only an
 * 'ok' caller may go on to spend money.
 *
 *   ok            reserved; settle it afterwards with settle_ai_spend
 *   duplicate     this exact press has already been served
 *   rate_limited  too many requests in the last minute
 *   over_cap      the reservation would cross the ceiling
 *
 * The window is a rolling twenty four hours rather than a calendar day. It
 * needs no timezone to be agreed on, and it cannot be walked around by waiting
 * for midnight.
 */
create or replace function reserve_ai_spend(
  p_owner          uuid,
  p_operation      text,
  p_model          text,
  p_reserve_micros bigint,
  p_limit_micros   bigint,
  p_max_per_minute int,
  p_request_token  text default null,
  p_hold_seconds   int default 120
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spent    bigint;
  v_recent   int;
  v_row      ai_usage%rowtype;
  v_existing ai_usage%rowtype;
begin
  if p_owner is null then
    raise exception 'reserve_ai_spend needs an owner' using errcode = 'null_value_not_allowed';
  end if;
  if p_reserve_micros is null or p_reserve_micros < 0 then
    raise exception 'a reservation needs a positive worst case'
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * Every decision for one owner, one at a time.
   *
   * Transaction scoped, so it lets go when this function's transaction ends,
   * whichever way that happens. Without it two simultaneous requests read the
   * same total, both pass, and the ceiling means nothing under exactly the load
   * it exists for.
   */
  perform pg_advisory_xact_lock(hashtext('ai_spend:' || p_owner::text));

  -- Reservations nobody came back for. Counted, not forgiven.
  update ai_usage
     set state = 'settled',
         note = coalesce(
           note,
           'abandoned before it was settled, so its reserved worst case stands')
   where owner_id = p_owner
     and state = 'reserved'
     and reserved_until < now();

  if p_request_token is not null and btrim(p_request_token) <> '' then
    select * into v_existing from ai_usage
     where owner_id = p_owner and request_token = p_request_token;
    if found then
      return jsonb_build_object(
        'status', 'duplicate',
        'usage_id', v_existing.id,
        'reason', 'this request has already been made');
    end if;
  end if;

  if p_max_per_minute is not null and p_max_per_minute > 0 then
    select count(*) into v_recent from ai_usage
     where owner_id = p_owner and created_at > now() - interval '1 minute';
    if v_recent >= p_max_per_minute then
      return jsonb_build_object(
        'status', 'rate_limited',
        'recent', v_recent,
        'allowed', p_max_per_minute);
    end if;
  end if;

  select coalesce(sum(
           case when state = 'reserved' then reserved_micros
                else coalesce(cost_micros, reserved_micros, 0) end), 0)
    into v_spent
    from ai_usage
   where owner_id = p_owner
     and created_at > now() - interval '24 hours';

  if v_spent + p_reserve_micros > p_limit_micros then
    return jsonb_build_object(
      'status', 'over_cap',
      'spent', v_spent,
      'reserve', p_reserve_micros,
      'limit', p_limit_micros);
  end if;

  insert into ai_usage (
    owner_id, operation, model, state, reserved_micros, reserved_until, request_token
  ) values (
    p_owner, p_operation, p_model, 'reserved', p_reserve_micros,
    now() + make_interval(secs => p_hold_seconds), nullif(btrim(coalesce(p_request_token, '')), '')
  )
  returning * into v_row;

  return jsonb_build_object(
    'status', 'ok',
    'usage_id', v_row.id,
    'spent', v_spent,
    'reserve', p_reserve_micros,
    'limit', p_limit_micros);
end;
$$;

/**
 * Replace a reservation with what the request really used.
 *
 * reserved_micros is deliberately left in place. When the actual cost is not
 * known, that figure is what the ceiling keeps counting, which is the whole
 * reason an unknown cost cannot be used to overspend.
 */
create or replace function settle_ai_spend(
  p_usage_id uuid,
  p_input    int default null,
  p_output   int default null,
  p_cost     bigint default null,
  p_error    text default null,
  p_note     text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_row ai_usage%rowtype;
begin
  update ai_usage
     set state = 'settled',
         input_tokens = p_input,
         output_tokens = p_output,
         cost_micros = p_cost,
         error = p_error,
         note = coalesce(p_note, note),
         reserved_until = null
   where id = p_usage_id and state = 'reserved'
   returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'not_reserved');
  end if;

  return jsonb_build_object(
    'status', 'settled',
    'usage_id', v_row.id,
    'cost_micros', v_row.cost_micros,
    'counted_micros', coalesce(v_row.cost_micros, v_row.reserved_micros, 0));
end;
$$;

/** What this owner has spent, or committed to spend, in the last 24 hours. */
create or replace function ai_spend_recent(p_owner uuid)
returns bigint
language sql
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(sum(
           case when state = 'reserved' then reserved_micros
                else coalesce(cost_micros, reserved_micros, 0) end), 0)::bigint
    from ai_usage
   where owner_id = p_owner
     and created_at > now() - interval '24 hours';
$$;

/*
 * Spend accounting is the server's business alone.
 *
 * A browser that could reserve, settle or read these would be a browser that
 * could book a reservation it never spends, settle somebody else's request for
 * nothing, or quietly free up budget. ai_usage stays readable by its owner
 * through its own policy; the arithmetic that enforces the ceiling does not.
 */
revoke all on function reserve_ai_spend(uuid, text, text, bigint, bigint, int, text, int)
  from public;
revoke all on function reserve_ai_spend(uuid, text, text, bigint, bigint, int, text, int)
  from anon, authenticated;
grant execute on function reserve_ai_spend(uuid, text, text, bigint, bigint, int, text, int)
  to service_role;

revoke all on function settle_ai_spend(uuid, int, int, bigint, text, text) from public;
revoke all on function settle_ai_spend(uuid, int, int, bigint, text, text) from anon, authenticated;
grant execute on function settle_ai_spend(uuid, int, int, bigint, text, text) to service_role;

revoke all on function ai_spend_recent(uuid) from public;
revoke all on function ai_spend_recent(uuid) from anon;
grant execute on function ai_spend_recent(uuid) to service_role;

comment on column ai_usage.reserved_micros is
  'The worst case booked before the request ran. Kept after settling, because '
  'a request whose actual cost is unknown is counted at this figure.';

comment on column ai_usage.request_token is
  'One value per press of Ask. The unique index on it is what stops a double '
  'click or a retried request being charged twice.';
