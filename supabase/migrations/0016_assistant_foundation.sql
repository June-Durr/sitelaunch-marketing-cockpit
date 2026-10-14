-- ---------------------------------------------------------------------------
-- 0016_assistant_foundation.sql
--
-- What the assistant is allowed to write down, and the distinctions it is not
-- allowed to collapse.
--
-- No model is involved in anything here. These are the records a model's output
-- has to be turned into before it counts, and the operations that turn it. The
-- extraction itself is one seam away; everything in this file works, and is
-- tested, without it.
--
-- THE DISTINCTION THIS FILE EXISTS FOR
--
-- "Friendly but not interested" is three different claims depending on who said
-- it. If the contact said it, it is evidence. If Alberto formed that impression,
-- it is a judgement that may be wrong. If a model inferred it from a transcript,
-- it is a guess. Storing all three in one notes field is how an inferred mood
-- becomes a confirmed fact three weeks later, and nobody can tell which it was.
--
-- So provenance is a column, it is NOT NULL, and it has no default. A caller
-- that does not say where a fact came from cannot write one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------------

create table if not exists extracted_facts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  lead_id     uuid references leads (id) on delete cascade,

  -- What kind of thing this is. Deliberately a small closed set: a free text
  -- "type" becomes forty spellings of the same idea within a month.
  kind        text not null check (kind in (
                'identity', 'channel', 'interest', 'concern',
                'promise', 'reply', 'next_step', 'other')),

  value       text not null check (length(btrim(value)) > 0),

  /**
   * Who is making this claim. No default, on purpose.
   *
   *   contact_stated     they said it. Evidence.
   *   user_impression    Alberto formed this view. A judgement, possibly wrong.
   *   assistant_inferred a model read it out of something. A guess.
   *
   * Nothing in the application may promote one to another. A user can accept an
   * inferred fact, which records acceptance; it does not rewrite where it came
   * from.
   */
  provenance  text not null check (provenance in (
                'contact_stated', 'user_impression', 'assistant_inferred')),

  -- The words this came from, so a person can check it rather than trust it.
  source_excerpt text,

  /**
   * The day this refers to, when one is actually known.
   *
   * Null is the normal case and is not a gap to be filled in later with
   * today's date. "They replied at some point" is a different fact from "they
   * replied on the eighth", and inventing the second from the first is the
   * failure this whole column exists to prevent.
   */
  occurred_on date,

  -- A person has looked at it and said yes or no. Both null means nobody has.
  accepted_at timestamptz,
  rejected_at timestamptz,

  -- Which record this fact was written into, once it was accepted.
  applied_to  text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint fact_is_not_both_accepted_and_rejected check (
    accepted_at is null or rejected_at is null),

  -- An inferred fact has to show its working. Something a model decided, with
  -- nothing to check it against, is not a record worth keeping.
  constraint inferred_facts_show_their_source check (
    provenance <> 'assistant_inferred'
    or length(btrim(coalesce(source_excerpt, ''))) > 0)
);

create index if not exists extracted_facts_lead_idx
  on extracted_facts (owner_id, lead_id, created_at desc);

-- What the review queue reads: facts nobody has ruled on yet.
create index if not exists extracted_facts_unreviewed_idx
  on extracted_facts (owner_id, created_at desc)
  where accepted_at is null and rejected_at is null;

create trigger extracted_facts_set_updated_at
  before update on extracted_facts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Drafts
--
-- The state machine that keeps "I wrote this" apart from "I sent this".
--
-- Copying a draft is not sending it. Opening a mail client is not sending it.
-- The only thing that records a send is a person saying so, and that is why
-- copied_at and sent_at are different columns rather than one "used" flag.
-- ---------------------------------------------------------------------------

create table if not exists message_drafts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  lead_id     uuid not null references leads (id) on delete cascade,

  -- The channel this was written for. Drafts are not channel neutral: a text
  -- and an email to the same person are different messages.
  channel     text,

  body        text not null check (length(btrim(body)) > 0),

  status      text not null default 'draft'
                check (status in ('draft', 'copied', 'sent', 'discarded')),

  copied_at   timestamptz,
  sent_at     timestamptz,
  -- The day it was actually sent, which is not always the day it was recorded.
  sent_on     date,

  -- The completion this became, once somebody confirmed the send.
  activity_id uuid references activity_events (id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A sent draft has to say when, and has to point at the record it produced.
  constraint sent_drafts_are_evidenced check (
    status <> 'sent'
    or (sent_at is not null and sent_on is not null)),

  -- And nothing else may carry a sent timestamp.
  constraint only_sent_drafts_are_sent check (
    status = 'sent' or sent_at is null)
);

create index if not exists message_drafts_lead_idx
  on message_drafts (owner_id, lead_id, created_at desc);

/**
 * At most one draft per lead per channel awaiting a decision.
 *
 * This is what makes "I sent it" resolvable. With two open drafts for the same
 * person on the same channel there is no way to know which one was sent, and
 * guessing would attach the wrong wording to a real contact. A second draft for
 * the same channel replaces the first, or the first is discarded; either way
 * there is one answer.
 */
create unique index if not exists message_drafts_one_open_per_channel
  on message_drafts (owner_id, lead_id, coalesce(channel, ''))
  where status in ('draft', 'copied');

create trigger message_drafts_set_updated_at
  before update on message_drafts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Usage
--
-- Measured from the first release, as a cost the business can see rather than
-- a surprise on a bill. No customer billing here: this is internal accounting,
-- and credit packages are a pricing decision for later.
--
-- Cost is stored in millionths of a currency unit, as an integer. Model prices
-- are quoted per million tokens and a float would accumulate rounding error
-- across thousands of rows, which is the one thing a cost table must not do.
-- ---------------------------------------------------------------------------

create table if not exists ai_usage (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,

  -- What the model was asked to do, so cost can be attributed to a feature
  -- rather than to "the assistant".
  operation     text not null,
  model         text not null,

  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),

  -- Millionths. 1_000_000 is one unit of currency.
  cost_micros   bigint not null default 0 check (cost_micros >= 0),

  -- Set when a request failed, so a failed call is not counted as a working
  -- one and its cost is still recorded, because a failed call is still billed.
  error         text,

  created_at    timestamptz not null default now()
);

create index if not exists ai_usage_owner_day_idx
  on ai_usage (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Who can see any of this
--
-- Owner scoped like everything else. Facts and drafts are read and written by
-- their owner through the operations below. Usage is read only to its owner:
-- the application records it server side, and a browser that could write usage
-- rows could understate what it had spent.
-- ---------------------------------------------------------------------------

alter table extracted_facts enable row level security;
alter table message_drafts  enable row level security;
alter table ai_usage        enable row level security;

drop policy if exists extracted_facts_owner_all on extracted_facts;
create policy extracted_facts_owner_all on extracted_facts
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists message_drafts_owner_all on message_drafts;
create policy message_drafts_owner_all on message_drafts
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists ai_usage_owner_read on ai_usage;
create policy ai_usage_owner_read on ai_usage
  for select to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- The operation one instruction produces
-- ---------------------------------------------------------------------------

/**
 * Record a conversation that happened, and move everything that follows from it.
 *
 * This is the "one instruction, all the linked updates" path: the lead is
 * updated where the caller has something better than what is stored, the
 * activity is written, the follow-up moves, and both syncs are queued. One
 * transaction, idempotent on a token, exactly like complete_task_operation.
 *
 * WHAT IT WILL NOT DO
 *
 * Invent a date. p_occurred_on is required and is the day the caller actually
 * knows about. Overwrite a stored channel or next action with null. Mark
 * anything as sent: this records contact that the person has said happened.
 */
create or replace function record_conversation(
  p_lead_id        uuid,
  p_token          text,
  p_occurred_on    date,
  p_summary        text,
  p_channel        text default null,
  p_activity_type  activity_type default 'conversation',
  p_approved_message text default null,
  p_outcome        text default null,
  p_next_due_date  date default null,
  p_next_action    text default null,
  p_evidence       text default 'User report'
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lead     leads%rowtype;
  v_existing activity_events%rowtype;
  v_activity activity_events%rowtype;
begin
  select * into v_lead from leads where id = p_lead_id;
  if not found then
    raise exception 'lead % is not available', p_lead_id using errcode = 'no_data_found';
  end if;

  -- The token is the whole duplicate defence, same as the completion path.
  select * into v_existing from activity_events
   where owner_id = v_lead.owner_id and idempotency_token = p_token;
  if found then
    return jsonb_build_object(
      'activity_id', v_existing.id, 'reused', true,
      'reason', 'this conversation was already recorded');
  end if;

  insert into activity_events (
    owner_id, occurred_at, activity_type, title, details, source, lead_id,
    channel, approved_message, outcome, evidence_source, idempotency_token,
    calendar_history_wanted, calendar_sync_status, is_seed
  ) values (
    v_lead.owner_id,
    -- Midday on the stated day. The Cockpit knows the day and not the minute,
    -- and midday keeps it on the right date either side of a timezone.
    (p_occurred_on::timestamptz + interval '12 hours'),
    p_activity_type,
    coalesce(nullif(btrim(p_summary), ''), 'Conversation recorded'),
    p_summary, 'manual', p_lead_id,
    p_channel, p_approved_message, p_outcome, p_evidence, p_token,
    true, 'pending', false
  )
  returning * into v_activity;

  update leads
     set
       -- Only where the caller has something and the record does not. An
       -- assistant must not blank a channel somebody confirmed by hand.
       preferred_channel = coalesce(nullif(btrim(coalesce(p_channel, '')), ''), preferred_channel),
       next_action_date  = coalesce(p_next_due_date, next_action_date),
       next_action       = coalesce(nullif(btrim(coalesce(p_next_action, '')), ''), next_action),
       reported_last_touch_at = greatest(
         coalesce(reported_last_touch_at, p_occurred_on), p_occurred_on)
   where id = p_lead_id;

  perform enqueue_sync_job(v_lead.owner_id, 'calendar', v_lead.owner_id::text);
  perform enqueue_sync_job(v_lead.owner_id, 'lead_mirror', v_lead.owner_id::text);

  return jsonb_build_object(
    'activity_id', v_activity.id,
    'reused', false,
    'lead_id', p_lead_id,
    'occurred_on', p_occurred_on,
    'next_due_date', p_next_due_date
  );
end;
$$;

/**
 * Resolve "I sent it" to one draft, and turn it into a recorded contact.
 *
 * Returns 'ambiguous' with the candidates rather than guessing. Attaching the
 * wrong wording to a real contact is worse than one more question, because the
 * record then says something was sent that was not.
 */
create or replace function mark_draft_sent(
  p_draft_id   uuid,
  p_token      text,
  p_sent_on    date default null,
  p_final_body text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_draft  message_drafts%rowtype;
  v_day    date;
  v_result jsonb;
begin
  select * into v_draft from message_drafts
   where id = p_draft_id and status in ('draft', 'copied');
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_day := coalesce(p_sent_on, current_date);

  -- The wording that was actually sent, which may differ from what was drafted
  -- because somebody edited it in the other application before sending.
  if p_final_body is not null and btrim(p_final_body) <> '' then
    update message_drafts set body = p_final_body where id = p_draft_id;
    v_draft.body := p_final_body;
  end if;

  v_result := record_conversation(
    v_draft.lead_id, p_token, v_day,
    'Message sent', v_draft.channel, 'follow_up_sent',
    v_draft.body, null, null, null, 'User confirmed send');

  update message_drafts
     set status = 'sent',
         sent_at = now(),
         sent_on = v_day,
         activity_id = (v_result ->> 'activity_id')::uuid
   where id = p_draft_id;

  return jsonb_build_object(
    'status', 'sent',
    'draft_id', p_draft_id,
    'activity_id', v_result ->> 'activity_id',
    'sent_on', v_day
  );
end;
$$;

/**
 * Note that a draft was copied. Deliberately not a send.
 *
 * Recording it at all is useful: it is what lets the assistant ask "did you
 * send the one you copied?" rather than asking about every draft ever written.
 */
create or replace function mark_draft_copied(p_draft_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update message_drafts
     set status = 'copied', copied_at = now()
   where id = p_draft_id and status = 'draft';
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- Said out loud in the return value, because this is the exact place the
  -- mistake would be made.
  return jsonb_build_object('status', 'copied', 'sent', false);
end;
$$;

grant execute on function record_conversation(
  uuid, text, date, text, text, activity_type, text, text, date, text, text
) to authenticated, service_role;
grant execute on function mark_draft_sent(uuid, text, date, text) to authenticated, service_role;
grant execute on function mark_draft_copied(uuid) to authenticated, service_role;

comment on table extracted_facts is
  'What the assistant read out of something somebody said, with who is making '
  'the claim. provenance has no default: a caller that will not say where a '
  'fact came from cannot write one.';

comment on table message_drafts is
  'Written, copied and sent are three different states. Only a person saying so '
  'moves a draft to sent.';
