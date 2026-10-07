-- SiteLaunch Marketing Cockpit, migration 0010
--
-- Somewhere to keep a person's Google refresh token, and somewhere to keep the
-- one-use state of an authorization in progress.
--
-- WHY THE TOKEN IS NOT A COLUMN ON integration_connections
--
-- That table is read by the browser. Row level security scopes it to the signed
-- in owner, so a token there would not leak between accounts, but it would be
-- sitting in a response that a browser extension, a screenshot, a devtools tab or
-- a support session can see. A refresh token is a long-lived key to somebody's
-- Google account. It belongs where the browser has no path to it at all, which is
-- Vault, reached only through the two security definer functions below.
--
-- WHAT THE BROWSER MAY STILL SEE
--
-- Everything it needs and nothing more: that a connection exists, which Google
-- account it belongs to, which scopes were granted, when it was connected, when
-- it last synced, and a sanitized reason if the last attempt failed. All of that
-- already lives on integration_connections and none of it is secret.
--
-- NOTHING HERE IS READABLE BY anon OR authenticated.
-- Both tables have row level security on and no policy at all, which denies
-- everything, and privileges are revoked besides. Only the service role, which
-- bypasses row level security and is held by the Edge Functions, can reach them.

-- ---------------------------------------------------------------------------
-- The authorization attempts
-- ---------------------------------------------------------------------------

/**
 * One row per authorization the Cockpit has started, consumed exactly once.
 *
 * WHY THE HASH AND NOT THE VALUE
 *
 * For the few minutes it lives, the state is a bearer value: whoever holds it can
 * complete that authorization. Storing its SHA-256 means a reader of this table
 * gains nothing, the same reasoning as never storing a password.
 *
 * WHY A ROW AND NOT A SIGNATURE
 *
 * A signature proves we issued a value. It cannot say whether it has already been
 * used, and a replayed callback is the attack this is here to stop. A row can be
 * consumed once; a signature never can.
 */
create table calendar_oauth_states (
  state_hash  text primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,

  constraint state_hash_is_a_sha256 check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint state_expires_after_it_is_created check (expires_at > created_at)
);

create index calendar_oauth_states_expiry_idx on calendar_oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- The tokens
-- ---------------------------------------------------------------------------

/**
 * Which Vault secret holds this owner's refresh token.
 *
 * The token itself is never in this table, only the id of the Vault entry that
 * holds it. One row per owner: reconnecting replaces the secret rather than
 * accumulating them.
 */
create table calendar_oauth_tokens (
  owner_id        uuid primary key references auth.users (id) on delete cascade,
  vault_secret_id uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger calendar_oauth_tokens_set_updated_at
  before update on calendar_oauth_tokens
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Locking both of them down
-- ---------------------------------------------------------------------------

alter table calendar_oauth_states enable row level security;
alter table calendar_oauth_tokens enable row level security;

-- No policy is created for either table on purpose. With row level security on
-- and no policy, every select, insert, update and delete by anon or authenticated
-- matches nothing and is refused. The service role bypasses row level security,
-- which is how the Edge Functions reach them and nothing else does.

revoke all on calendar_oauth_states from anon, authenticated;
revoke all on calendar_oauth_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reaching Vault
--
-- PostgREST does not expose the vault schema, and it should not: an Edge Function
-- that could run arbitrary queries against Vault would be able to read every
-- secret the project has. These three functions are the only way in, they each do
-- exactly one thing, and they are executable by the service role alone.
-- ---------------------------------------------------------------------------

/**
 * Store or replace this owner's refresh token.
 *
 * WHY A NULL TOKEN IS NOT AN ERROR
 *
 * Google only returns a refresh token when it feels like it: on a reconnection it
 * often returns an access token and nothing else, on the grounds that the caller
 * already has one. Treating that as a failure would break reconnection, and
 * writing a null over the stored token would turn a working connection into one
 * that can never refresh again. So a null leaves what is there untouched, and the
 * function says which of the two happened.
 */
create or replace function calendar_oauth_store_token(
  p_owner        uuid,
  p_refresh_token text
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  existing uuid;
  new_id   uuid;
begin
  select vault_secret_id into existing
    from calendar_oauth_tokens where owner_id = p_owner;

  if p_refresh_token is null or length(btrim(p_refresh_token)) = 0 then
    if existing is null then
      return 'no_token';
    end if;
    -- Reconnection with no new token, and one already held. Keep it.
    update calendar_oauth_tokens set updated_at = now() where owner_id = p_owner;
    return 'kept_existing';
  end if;

  if existing is not null then
    -- Replace the secret in place, so the id on the row stays correct and no
    -- orphaned secret is left behind holding a live credential.
    perform vault.update_secret(existing, p_refresh_token);
    update calendar_oauth_tokens set updated_at = now() where owner_id = p_owner;
    return 'replaced';
  end if;

  new_id := vault.create_secret(
    p_refresh_token,
    'calendar_refresh_token_' || p_owner::text,
    'Google Calendar refresh token for one Cockpit owner. Never leaves the server.'
  );
  insert into calendar_oauth_tokens (owner_id, vault_secret_id)
  values (p_owner, new_id);
  return 'stored';
end;
$$;

/** This owner's refresh token, or null when there is none. */
create or replace function calendar_oauth_read_token(p_owner uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
  token     text;
begin
  select vault_secret_id into secret_id
    from calendar_oauth_tokens where owner_id = p_owner;
  if secret_id is null then return null; end if;

  select decrypted_secret into token
    from vault.decrypted_secrets where id = secret_id;
  return token;
end;
$$;

/**
 * Forget this owner's token entirely.
 *
 * Deletes the Vault secret as well as the row, because a disconnection that left
 * the credential sitting in Vault would be a disconnection in name only. Returns
 * the token first so the caller can tell Google about it, which is the one moment
 * it is legitimate for this value to leave the database.
 */
create or replace function calendar_oauth_forget_token(p_owner uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
  token     text;
begin
  select vault_secret_id into secret_id
    from calendar_oauth_tokens where owner_id = p_owner;
  if secret_id is null then return null; end if;

  select decrypted_secret into token
    from vault.decrypted_secrets where id = secret_id;

  delete from calendar_oauth_tokens where owner_id = p_owner;
  delete from vault.secrets where id = secret_id;
  return token;
end;
$$;

/**
 * Every owner with a stored token.
 *
 * What the scheduled sync iterates. It deliberately returns ids and nothing else:
 * a scheduled run needs to know whose calendars to write to, not what their
 * credentials are.
 */
create or replace function calendar_oauth_owners()
returns table (owner_id uuid)
language sql
security definer
set search_path = public
as $$
  select owner_id from calendar_oauth_tokens order by owner_id
$$;

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- The authorization attempts, issued and spent
--
-- WHY THIS IS SQL AND NOT TYPESCRIPT
--
-- Because single use is a property of the statement, not of the caller. Reading
-- a row and then marking it used leaves a window in which two callbacks arriving
-- together both read an unused row and both proceed, and no amount of care in
-- the calling code closes that window. One conditional update cannot do it:
-- Postgres serialises the two, the first matches and the second matches nothing.
--
-- Keeping it here also means the rule is testable against a real Postgres rather
-- than against a mock that was written to agree with it.
-- ---------------------------------------------------------------------------

/**
 * Record an authorization this owner has just started.
 *
 * The lifetime is an argument rather than a constant so the caller and the
 * schema cannot drift apart, and it is bounded here because a state good for a
 * day is a replay window good for a day.
 */
create or replace function calendar_oauth_issue_state(
  p_owner       uuid,
  p_state_hash  text,
  p_lifetime_seconds integer default 600
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lifetime_seconds is null or p_lifetime_seconds < 60 or p_lifetime_seconds > 3600 then
    raise exception 'An authorization must live between one minute and one hour';
  end if;

  insert into calendar_oauth_states (state_hash, owner_id, expires_at)
  values (p_state_hash, p_owner, now() + make_interval(secs => p_lifetime_seconds));
end;
$$;

/**
 * Spend one state, exactly once, and say whose it was.
 *
 * Returns the owner on the single occasion the state is genuine, unused and
 * still current, and null every other time. Expired, already spent and never
 * issued all look identical from outside, which is correct: they are all "no",
 * and telling them apart would describe this table to whoever is probing it.
 */
create or replace function calendar_oauth_consume_state(p_state_hash text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  found uuid;
begin
  update calendar_oauth_states
     set used_at = now()
   where state_hash = p_state_hash
     and used_at is null
     and expires_at > now()
  returning owner_id into found;

  return found;
end;
$$;

/**
 * Throw away states that are no longer any use.
 *
 * Housekeeping, not correctness. Consuming a state is what makes it one use; this
 * only stops an unbounded table of spent hashes accumulating.
 */
create or replace function calendar_oauth_prune_states(p_older_than_seconds integer default 600)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from calendar_oauth_states
   where expires_at < now() - make_interval(secs => greatest(p_older_than_seconds, 0));
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- Who may call them
--
-- The service role and nobody else. These are security definer, so a grant to
-- authenticated would let any signed in person read every owner's refresh token,
-- which is the one mistake that would make this entire migration pointless.
-- ---------------------------------------------------------------------------

do $$
declare fn text;
begin
  foreach fn in array array[
    'calendar_oauth_store_token(uuid, text)',
    'calendar_oauth_read_token(uuid)',
    'calendar_oauth_forget_token(uuid)',
    'calendar_oauth_owners()',
    'calendar_oauth_issue_state(uuid, text, integer)',
    'calendar_oauth_consume_state(text)',
    'calendar_oauth_prune_states(integer)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon, authenticated', fn);
    -- service_role exists on Supabase; in a bare Postgres used for testing it is
    -- created by the harness. Either way the grant is explicit.
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

comment on function calendar_oauth_read_token(uuid) is
  'Returns one owner''s Google refresh token. Service role only. Never exposed '
  'through PostgREST to anon or authenticated, and never returned to a browser.';
