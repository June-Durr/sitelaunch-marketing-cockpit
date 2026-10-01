-- SiteLaunch Marketing Cockpit, migration 0006
--
-- Scheduling for the two analytics sync functions.
--
-- THIS MIGRATION DOES NOT START ANYTHING
--
-- It installs the extensions and the helper that a schedule needs, and stops
-- there. No cron job is created, so applying this file changes no behaviour and
-- calls no Google property. The two statements that actually start the schedule
-- are at the bottom, commented, to be run deliberately and separately once the
-- functions have been deployed and tested. Turning a sync on is a decision, not a
-- side effect of applying a migration.
--
-- NOTHING SECRET IS WRITTEN HERE
--
-- The shared secret the scheduler presents lives in Supabase Vault and is read at
-- call time by the helper below. It is not a column, not a default, and not a
-- literal in this file. Anyone reading this migration learns the name of a secret
-- and not its value.
--
-- TO REMOVE ALL OF THIS
--
--   select cron.unschedule('sitelaunch-sync-ga4-daily');
--   select cron.unschedule('sitelaunch-sync-search-console-daily');
--   drop function if exists public.trigger_analytics_sync(text, text);
--
-- The job names are prefixed 'sitelaunch-' so they are easy to find among any
-- other jobs in the project.

-- ---------------------------------------------------------------------------
-- Extensions
--
-- pg_cron runs the schedule. pg_net makes the outbound HTTP call, because cron
-- can only run SQL and an Edge Function is reached over HTTP.
-- ---------------------------------------------------------------------------

-- pg_cron ignores the schema asked for here and installs itself into pg_catalog,
-- because its own control file fixes that and the schema clause is not an error.
-- Its scheduling functions live in the cron schema either way, so cron.schedule
-- below is correct. pg_net does land in extensions, and its functions live in the
-- net schema, which is why the helper calls net.http_post by its full name rather
-- than relying on search_path.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- The helper the schedule calls
--
-- Kept as one function taking the function name, so both providers share exactly
-- one code path and cannot drift apart. It reads two values from Vault:
--
--   sync_functions_base_url   https://<project-ref>.supabase.co/functions/v1
--   sync_cron_secret          the shared secret the functions check
--
-- Both are set with:
--   select vault.create_secret('<value>', '<name>', '<description>');
--
-- security definer so the job owner does not need rights on vault directly, and
-- search_path is pinned so a shadowing schema cannot redirect what it calls.
-- ---------------------------------------------------------------------------

create or replace function public.trigger_analytics_sync(
  function_name text,
  sync_mode text default 'daily'
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  base_url   text;
  cron_secret text;
  request_id bigint;
begin
  if function_name not in ('sync-ga4', 'sync-search-console') then
    raise exception 'Unknown sync function: %', function_name;
  end if;

  select decrypted_secret into base_url
    from vault.decrypted_secrets where name = 'sync_functions_base_url';
  select decrypted_secret into cron_secret
    from vault.decrypted_secrets where name = 'sync_cron_secret';

  if base_url is null or cron_secret is null then
    -- Refusing loudly beats firing a request with no credentials and recording
    -- a string of 401s that look like the sync itself is broken.
    raise exception 'Vault is missing sync_functions_base_url or sync_cron_secret';
  end if;

  select net.http_post(
    url     := base_url || '/' || function_name,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-sync-cron-secret', cron_secret
    ),
    body    := jsonb_build_object('mode', sync_mode),
    timeout_milliseconds := 120000
  ) into request_id;

  return request_id;
end;
$$;

comment on function public.trigger_analytics_sync(text, text) is
  'Calls one of the analytics sync Edge Functions. Credentials come from Vault. '
  'Invoked by the sitelaunch-sync-* cron jobs, which migration 0006 does not create.';

-- The helper reads Vault, so it must not be callable by ordinary users.
revoke all on function public.trigger_analytics_sync(text, text) from public;
revoke all on function public.trigger_analytics_sync(text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- ACTIVATION, deliberately not run by this migration
--
-- 08:00 UTC is chosen so the previous day has certainly ended in the property's
-- own timezone before anything is asked for. For a US timezone that is early
-- morning local, several hours after midnight, and the functions additionally
-- refuse to read today at all.
--
-- The two jobs are fifteen minutes apart so they do not contend for the same
-- outbound connections or hit Google's quota together.
--
--   select cron.schedule(
--     'sitelaunch-sync-ga4-daily', '0 8 * * *',
--     $job$ select public.trigger_analytics_sync('sync-ga4', 'daily'); $job$
--   );
--
--   select cron.schedule(
--     'sitelaunch-sync-search-console-daily', '15 8 * * *',
--     $job$ select public.trigger_analytics_sync('sync-search-console', 'daily'); $job$
--   );
--
-- To confirm afterwards:
--   select jobname, schedule, active from cron.job where jobname like 'sitelaunch-%';
--   select * from cron.job_run_details order by start_time desc limit 10;
-- ---------------------------------------------------------------------------
