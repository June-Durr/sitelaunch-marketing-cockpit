-- ---------------------------------------------------------------------------
-- 0017_assistant_capture.sql
--
-- "I met someone" as one operation.
--
-- 0016 gave the assistant somewhere to put facts, drafts and a recorded
-- conversation. The one thing it could not do was the first half of the first
-- flow: a person who is not in the Cockpit yet. Doing that from the browser
-- would be three writes that can each fail on their own, and the failure is not
-- an error message, it is a contact with no history or a history pointing at a
-- contact that was never created.
--
-- So this is one function, one transaction, idempotent on a token, exactly like
-- complete_task_operation and record_conversation. It creates the contact,
-- records the meeting when the day is actually known, writes the facts with
-- their provenance, and queues the syncs. Any part of it failing takes all of it
-- with it.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--
-- Decide the follow-up cadence. The caller passes a date or passes null, because
-- src/config/followUp.ts is the only implementation of that rule and a second
-- one in SQL would be a second thing to keep in agreement.
--
-- Treat the contact as a sales prospect. The stage is 'new_contact', which is
-- what somebody you met once is. Nothing here promotes anybody.
--
-- Mark anything as sent, replied to, or done.
-- ---------------------------------------------------------------------------

/**
 * Idempotency without a new column.
 *
 * leads already carries external_source and external_key with a unique index on
 * (owner_id, external_source, external_key), which is what makes a re-import an
 * update rather than a duplicate. A capture is the same problem wearing a
 * different hat: one press of Save, however many times the request arrives. So
 * the token goes in external_key under a source of its own, and the second call
 * finds the first one's row instead of writing another person.
 *
 * The index is partial, so it cannot be an ON CONFLICT target (the same reason
 * 0008 exists). The select comes first and the unique violation is caught
 * underneath it, which covers the case where two requests pass the select before
 * either insert lands.
 */
create or replace function capture_contact(
  p_token         text,
  p_name          text,
  p_organization  text default null,
  p_role          text default null,
  p_channel       text default null,
  p_handle        text default null,
  p_met_on        date default null,
  p_location      text default null,
  p_interest      text default null,
  p_summary       text default null,
  p_next_action   text default null,
  p_next_due_date date default null,
  p_facts         jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner       uuid := auth.uid();
  v_lead        leads%rowtype;
  v_name        text;
  v_notes       text;
  v_activity    jsonb := null;
  v_fact        jsonb;
  v_written     int := 0;
  v_skipped     int := 0;
  v_reused      boolean := false;
  v_provenance  text;
  v_kind        text;
  v_value       text;
  v_excerpt     text;
begin
  if v_owner is null then
    raise exception 'capture_contact needs a signed in caller' using errcode = 'insufficient_privilege';
  end if;
  if p_token is null or btrim(p_token) = '' then
    raise exception 'capture_contact needs a token' using errcode = 'null_value_not_allowed';
  end if;

  /*
   * A name, or the placeholder that means there is not one yet.
   *
   * prospect_name is NOT NULL and has been since 0001, so there is no such thing
   * as a lead with no name in this schema. The Cockpit's answer to a person
   * whose name is not known is the placeholder, which src/lib/leadLabel.ts and
   * server/integrations/leadNames.ts both recognise and neither displays: the
   * organisation is shown instead, and where there is no organisation either the
   * screen says the contact is not yet identified rather than inventing a label.
   */
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'Name pending');

  -- Already captured under this token.
  select * into v_lead from leads
   where owner_id = v_owner and external_source = 'assistant_capture'
     and external_key = p_token;

  if found then
    v_reused := true;
  else
    -- What was learned, in the person's own words, kept together rather than
    -- scattered across columns that do not exist for them.
    v_notes := concat_ws(
      E'\n',
      nullif(btrim(coalesce(p_role, '')), ''),
      case when nullif(btrim(coalesce(p_handle, '')), '') is not null
           then concat_ws(': ', nullif(btrim(coalesce(p_channel, '')), ''), btrim(p_handle))
           else null end,
      nullif(btrim(coalesce(p_location, '')), ''),
      nullif(btrim(coalesce(p_interest, '')), ''),
      nullif(btrim(coalesce(p_summary, '')), '')
    );

    begin
      insert into leads (
        prospect_name, organization, stage, source, project,
        preferred_channel, next_action, next_action_date, notes,
        external_source, external_key, follow_up_mode,
        first_contact_at, reported_last_touch_at, is_seed
      ) values (
        v_name,
        nullif(btrim(coalesce(p_organization, '')), ''),
        'new_contact',
        'Added by the assistant',
        nullif(btrim(coalesce(p_interest, '')), ''),
        nullif(btrim(coalesce(p_channel, '')), ''),
        nullif(btrim(coalesce(p_next_action, '')), ''),
        p_next_due_date,
        nullif(v_notes, ''),
        'assistant_capture', p_token, 'auto',
        p_met_on, p_met_on, false
      )
      returning * into v_lead;
    exception when unique_violation then
      -- Two requests got past the select. The first one's row is the answer.
      select * into v_lead from leads
       where owner_id = v_owner and external_source = 'assistant_capture'
         and external_key = p_token;
      if not found then raise; end if;
      v_reused := true;
    end;
  end if;

  /*
   * The meeting itself, only when the day is known.
   *
   * No date means no activity, and that is the correct outcome rather than a
   * gap to fill with today. "I met him at some point" is not a record that he
   * was met on the fourteenth. The contact is still saved, which is the useful
   * half, and the assistant asks about the day.
   */
  if p_met_on is not null and not v_reused then
    v_activity := record_conversation(
      v_lead.id,
      p_token || ':met',
      p_met_on,
      coalesce(nullif(btrim(coalesce(p_summary, '')), ''), 'Met in person'),
      nullif(btrim(coalesce(p_channel, '')), ''),
      case when lower(coalesce(p_channel, '')) in ('in person', 'in-person', 'event')
           then 'networking_event'::activity_type
           else 'conversation'::activity_type end,
      null, null, p_next_due_date, nullif(btrim(coalesce(p_next_action, '')), ''),
      'User report');
  end if;

  /*
   * The facts, one at a time, and never all or nothing.
   *
   * A fact that would break a constraint is counted and left out rather than
   * taking the contact down with it. The count is returned, so the screen says
   * "nine saved, one left out" instead of quietly keeping nine.
   */
  for v_fact in select * from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb))
  loop
    v_kind       := v_fact ->> 'kind';
    v_value      := nullif(btrim(coalesce(v_fact ->> 'value', '')), '');
    v_provenance := v_fact ->> 'provenance';
    -- Both spellings accepted: the validated proposal arrives in the browser's
    -- camel case, and anything written by hand or by a later server path will
    -- use the column names.
    v_excerpt    := nullif(btrim(coalesce(
                      v_fact ->> 'sourceExcerpt', v_fact ->> 'source_excerpt', '')), '');

    if v_value is null
       or v_kind not in ('identity','channel','interest','concern','promise','reply','next_step','other')
       or v_provenance not in ('contact_stated','user_impression','assistant_inferred')
       or (v_provenance = 'assistant_inferred' and v_excerpt is null)
    then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    /*
     * owner_id is written out rather than defaulted.
     *
     * 0001's tables carry `default auth.uid()`; 0016's three do not, so an
     * insert that leaves it off fails its own row level security policy. Found
     * by running this against Postgres rather than by reading the file.
     */
    insert into extracted_facts (
      owner_id, lead_id, kind, value, provenance, source_excerpt, occurred_on
    ) values (
      v_owner, v_lead.id, v_kind, v_value, v_provenance, v_excerpt,
      -- A fact's own day, when it has one. Never defaulted to the meeting.
      case when coalesce(v_fact ->> 'occurredOn', v_fact ->> 'occurred_on', '')
                ~ '^\d{4}-\d{2}-\d{2}$'
           then coalesce(v_fact ->> 'occurredOn', v_fact ->> 'occurred_on')::date
           else null end
    );
    v_written := v_written + 1;
  end loop;

  -- The mirror needs to know about the new contact even when no activity was
  -- recorded, so this is queued outside the activity branch.
  perform enqueue_sync_job(v_owner, 'lead_mirror', v_owner::text);

  return jsonb_build_object(
    'lead_id', v_lead.id,
    'reused', v_reused,
    'name', v_lead.prospect_name,
    'activity_id', v_activity -> 'activity_id',
    'recorded_meeting', v_activity is not null,
    'facts_written', v_written,
    'facts_skipped', v_skipped,
    'next_due_date', v_lead.next_action_date
  );
end;
$$;

grant execute on function capture_contact(
  text, text, text, text, text, text, date, text, text, text, text, date, jsonb
) to authenticated, service_role;

/**
 * Write a draft without ever ending up with two open ones.
 *
 * 0016's unique index allows one draft per contact per channel in draft or
 * copied state, which is what makes "I sent it" answerable. A second draft for
 * the same channel is a revision of the first, not a new message, so this
 * updates in place rather than failing or piling up.
 */
create or replace function save_message_draft(
  p_lead_id uuid,
  p_channel text,
  p_body    text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_draft message_drafts%rowtype;
  v_lead  leads%rowtype;
begin
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'a draft needs a body' using errcode = 'null_value_not_allowed';
  end if;

  -- Read through the caller's own view of leads, so a draft cannot be attached
  -- to somebody else's contact even by id. owner_id comes off the row rather
  -- than from the argument list, because 0016 gives these tables no default.
  select * into v_lead from leads where id = p_lead_id;
  if not found then
    raise exception 'lead % is not available', p_lead_id using errcode = 'no_data_found';
  end if;

  select * into v_draft from message_drafts
   where lead_id = p_lead_id
     and coalesce(channel, '') = coalesce(nullif(btrim(coalesce(p_channel, '')), ''), '')
     and status in ('draft', 'copied');

  if found then
    update message_drafts
       set body = p_body,
           -- Back to 'draft': the wording that was copied is not this wording,
           -- so the copy that was taken no longer describes what is here.
           status = 'draft',
           copied_at = null
     where id = v_draft.id
     returning * into v_draft;
  else
    insert into message_drafts (owner_id, lead_id, channel, body, status)
    values (v_lead.owner_id, p_lead_id, nullif(btrim(coalesce(p_channel, '')), ''),
            p_body, 'draft')
    returning * into v_draft;
  end if;

  return jsonb_build_object(
    'draft_id', v_draft.id,
    'status', v_draft.status,
    'sent', false,
    'channel', v_draft.channel
  );
end;
$$;

grant execute on function save_message_draft(uuid, text, text) to authenticated, service_role;

comment on function capture_contact(
  text, text, text, text, text, text, date, text, text, text, text, date, jsonb
) is
  'One instruction, all the linked writes: the contact, the meeting when the day '
  'is known, the facts with their provenance, and the sync. Idempotent on a '
  'token held in external_key.';
