-- ---------------------------------------------------------------------------
-- 0021_capture_keeps_the_number.sql
--
-- A phone number that never reached the phone column.
--
-- capture_contact took the contact's handle and wrote it into the notes, as
-- "Text: 305 555 0188". That is where an @name belongs, and it is the wrong
-- place for a number: nothing could dial it, the contact card export had no
-- number to put on the card, and the link that opens a messaging app had
-- nothing to open. Every contact the assistant has ever captured has the same
-- gap.
--
-- So the handle now goes where its shape says it goes. A number lands in phone,
-- an address lands in email, and anything that is neither stays in the notes
-- exactly as before. The shape decides rather than the channel, because the
-- channel is somebody's word for how they talk to a person and the two do not
-- always agree: a contact whose preferred channel is "Text" can still have an
-- address written down.
--
-- The notes keep their copy either way. It costs nothing, it is what somebody
-- would read first, and removing it would lose the label somebody typed.
--
-- The function is here in full for the same reason it was in 0020: Postgres
-- replaces a body whole or not at all. It was lifted out of 0020 by a script
-- with three substitutions rather than retyped.
-- ---------------------------------------------------------------------------

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
  v_handle      text;
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

  -- Trimmed once, then read three times below.
  v_handle := nullif(btrim(coalesce(p_handle, '')), '');

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
        prospect_name, organization, phone, email, stage, source, project,
        preferred_channel, next_action, next_action_date, notes,
        external_source, external_key, follow_up_mode,
        first_contact_at, reported_last_touch_at, is_seed
      ) values (
        v_name,
        nullif(btrim(coalesce(p_organization, '')), ''),
        /*
         * The handle, put where it belongs.
         *
         * A handle is whatever somebody reads off a business card: a number, an
         * address, or an @name. Only the first two have a column, and guessing
         * wrong is worse than leaving one empty, so the shape decides. Anything
         * that is neither stays in the notes, which is where all of them used to
         * end up.
         */
        case when v_handle ~ '^[+0-9][+0-9 ()./-]{6,}$' then v_handle else null end,
        case when v_handle ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
             then lower(v_handle) else null end,
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
       or not fact_provenance_allowed(v_provenance)
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

comment on function capture_contact(
  text, text, text, text, text, text, date, text, text, text, text, date, jsonb
) is
  'One instruction, all the linked writes: the contact, the meeting when the day '
  'is known, the facts with their provenance, and the sync. A handle that looks '
  'like a number or an address is filed as one. Idempotent on a token held in '
  'external_key.';
