-- SiteLaunch Marketing Cockpit — verified seed data
--
-- THIS IS NOT A MIGRATION, AND IT USED TO BE ONE. THAT WAS A MISTAKE.
--
-- Every row here needs an owner, and an owner is a row in auth.users. A migration
-- runs against an empty database before anybody has signed up, so this file could
-- not work where it used to live: it would either fail outright or, worse, attach
-- the records to whichever user happened to exist first.
--
-- It now runs by hand, after a user exists, and only when demonstration data is
-- actually wanted. A real project does not need it at all.
--
-- HOW TO RUN IT
--
--   1. Apply every file in supabase/migrations in order.
--   2. Sign in once through the app, or create a user in the Supabase dashboard.
--   3. Run this file in the SQL editor while signed in as that user.
--
-- It attaches to auth.uid() when there is one, and otherwise to the oldest user in
-- the project. On a project with several users, sign in first so it does not guess.
--
--
-- Everything here is marked is_seed = true so it can be identified and removed.
-- Only figures that were actually observed are entered. Anything that was not
-- reported by the platform is left NULL (unknown) or flagged metrics_unavailable
-- (the platform does not expose it). These are different states and stay different.
--
-- Publish dates and capture times are date-only facts. Stored at MIDDAY UTC so they
-- resolve to the same calendar day in every timezone; at UTC midnight they read as
-- the previous day west of Greenwich, pulling every measurement window forward a day.
--
-- Run after 0001_init.sql, signed in, or with a user present in auth.users.

do $$
declare
  v_owner        uuid;
  v_ig_account   uuid;
  v_fb_account   uuid;
  v_group        uuid := gen_random_uuid();
  v_ig_story     uuid;
  v_fb_story     uuid;
  v_outlier      uuid;
begin
  v_owner := coalesce(auth.uid(), (select id from auth.users order by created_at limit 1));
  if v_owner is null then
    raise exception 'No user found. Create a Supabase auth user before seeding.';
  end if;

  -- -------------------------------------------------------------------------
  -- Accounts
  -- -------------------------------------------------------------------------
  insert into accounts (owner_id, platform, handle, display_name, is_seed)
  values (v_owner, 'instagram', '@sitelaunchstudios', 'SiteLaunch Studios (Instagram)', true)
  returning id into v_ig_account;

  insert into accounts (owner_id, platform, handle, display_name, notes, is_seed)
  values (v_owner, 'facebook', 'SiteLaunch Studios', 'SiteLaunch Studios (Facebook Page)',
          'Stories cross-posted from Instagram do not report content-level metrics here.', true)
  returning id into v_fb_account;

  -- -------------------------------------------------------------------------
  -- Content 1a — SiteLaunch BTS Story, Instagram
  -- Cross-posted to Facebook. Two rows, one per account, sharing a group id,
  -- because per-account metrics must never be merged into a single figure.
  -- -------------------------------------------------------------------------
  insert into content_items (
    owner_id, account_id, cross_post_group_id, title, format, status, published_at,
    pillar, target_audience, hook, cta, destination_url,
    utm_source, utm_medium, utm_campaign, notes, is_seed
  ) values (
    v_owner, v_ig_account, v_group, 'SiteLaunch BTS Story', 'story', 'published',
    timestamptz '2026-09-13 12:00:00+00',
    'Behind the scenes', 'Local service businesses considering a new website',
    null, 'Website link with tracked UTM',
    'https://sitelaunchstudios.com/?utm_source=instagram&utm_medium=story&utm_campaign=bts_story_2026_09',
    'instagram', 'story', 'bts_story_2026_09',
    'Publish time of day not recorded. 24-hour reading taken from Instagram insights.',
    true
  ) returning id into v_ig_story;

  -- Content 1b — the same story as it appeared on Facebook
  insert into content_items (
    owner_id, account_id, cross_post_group_id, title, format, status, published_at,
    pillar, target_audience, cta, destination_url,
    utm_source, utm_medium, utm_campaign, notes, is_seed
  ) values (
    v_owner, v_fb_account, v_group, 'SiteLaunch BTS Story (Facebook cross-post)',
    'story', 'published', timestamptz '2026-09-13 12:00:00+00',
    'Behind the scenes', 'Local service businesses considering a new website',
    'Website link with tracked UTM',
    'https://sitelaunchstudios.com/?utm_source=facebook&utm_medium=story&utm_campaign=bts_story_2026_09',
    'facebook', 'story', 'bts_story_2026_09',
    'Facebook reports no content-level metrics for this story.', true
  ) returning id into v_fb_story;

  -- 24-hour reading, Instagram. Views is the ONLY figure that was observed.
  -- Every other metric stays NULL: not checked is not the same as zero.
  insert into performance_snapshots (
    owner_id, content_item_id, window_type, captured_at, views, ingest_source, notes, is_seed
  ) values (
    v_owner, v_ig_story, '24h', timestamptz '2026-09-14 12:00:00+00', 31, 'manual',
    'Instagram story views at 24 hours. No other metric recorded.', true
  );

  -- Facebook: the platform does not expose content-level metrics for this story.
  -- Flagged as unavailable rather than left blank, so it is not mistaken for a
  -- measurement the operator simply has not taken yet.
  insert into performance_snapshots (
    owner_id, content_item_id, window_type, captured_at,
    metrics_unavailable, unavailable_reason, ingest_source, is_seed
  ) values (
    v_owner, v_fb_story, '24h', timestamptz '2026-09-14 12:00:00+00',
    true, 'Facebook does not report content-level metrics for cross-posted Stories.',
    'manual', true
  );

  -- Website outcome observed against this campaign: 1 session, facebook / story.
  -- Linked to the Facebook row because the source/medium identifies it. Downstream
  -- lead attribution is unknown and is therefore left NULL, not assumed to be zero.
  insert into traffic_snapshots (
    owner_id, content_item_id, range_start, range_end,
    source, medium, campaign, sessions, ingest_source, notes, is_seed
  ) values (
    v_owner, v_fb_story, date '2026-09-13', date '2026-09-14',
    'facebook', 'story', 'bts_story_2026_09', 1, 'manual',
    'GA4 source/medium facebook / story. Attributable lead: unknown, not shown in GA4.',
    true
  );

  -- Seven-day measurement due 2026-09-20.
  insert into tasks (
    owner_id, content_item_id, title, task_type, status, due_date, window_type, notes, is_seed
  ) values (
    v_owner, v_ig_story, 'Record 7-day metrics for SiteLaunch BTS Story',
    'measurement_check', 'open', date '2026-09-20', '7d',
    'Instagram story insights expire. Capture before the window closes.', true
  );

  insert into tasks (
    owner_id, content_item_id, title, task_type, status, due_date, window_type, notes, is_seed
  ) values (
    v_owner, v_fb_story, 'Check GA4 for facebook / story sessions, 7-day window',
    'measurement_check', 'open', date '2026-09-20', '7d',
    'Facebook has no content-level metrics; GA4 is the only downstream signal.', true
  );

  -- -------------------------------------------------------------------------
  -- Historical outlier — externally amplified Instagram Story.
  -- Retained for the record, excluded from every comparison baseline.
  -- -------------------------------------------------------------------------
  insert into content_items (
    owner_id, account_id, title, format, status, published_at,
    is_externally_amplified, amplifier_name, amplification_note, notes, is_seed
  ) values (
    v_owner, v_ig_account, 'Instagram Story boosted by Only in Dade',
    'story', 'measured', timestamptz '2026-09-01 12:00:00+00',
    true, 'Only in Dade',
    'Reach driven by a third-party account, not by the content or the audience. '
    || 'Excluded from all cohort averages.',
    'No material business outcome reported. Kept as a record of what amplified reach '
    || 'looks like without downstream action.',
    true
  ) returning id into v_outlier;

  -- Views approximate (~30,300) and recorded as such in the note. No other metric
  -- observed; downstream figures stay NULL because none were reported.
  insert into performance_snapshots (
    owner_id, content_item_id, window_type, captured_at, views, ingest_source, notes, is_seed
  ) values (
    v_owner, v_outlier, 'custom', timestamptz '2026-09-03 12:00:00+00', 30300, 'manual',
    'Approximate figure (~30,300). Externally amplified. No material business result reported.',
    true
  );
end;
$$;
