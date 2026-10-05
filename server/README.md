# Server side integrations

Nothing in this directory runs in the browser, and nothing in `src/` may import from
it. Vite only bundles what is reachable from `src/main.tsx`, so these files are
typechecked but never shipped to a client.

## Why the boundary exists

Anything the browser can read, a user can read. Open the developer tools, look at the
network tab, read the bundle. That is true of every value in a `VITE_` environment
variable, because Vite inlines those at build time.

So the rule is simple and absolute:

- **In the browser:** the Supabase URL and the anon key. Both are designed to be
  public. The anon key grants nothing on its own; row level security decides what
  the signed in user can actually see.
- **Server side only:** every provider client secret, refresh token, access token,
  and the Supabase service role key. These live in the secret store of whatever
  runs the sync, most likely Supabase Edge Function secrets or Supabase Vault.

A GA4 or Meta adapter must never be added to the browser repository in `src/data/`.
The sync runs server side, writes into Supabase, and the browser reads the results
through the same row level security as everything else.

## What is here now

Type contracts and documented behaviour, no implementations. There is deliberately
no OAuth code, no HTTP client, no credentials and no fake responses. A stub that
returns invented data is worse than nothing, because it looks like it works.

| File | Holds |
|---|---|
| `integrations/types.ts` | Shared provider, status, stage and run types |
| `integrations/calendar.ts` | The Google Calendar sync contract and its rules |
| `integrations/analytics.ts` | The GA4 and Search Console sync contracts |
| `integrations/googleAuth.ts` | Service account to access token, and the seam for customer OAuth later |
| `integrations/ga4.ts` | Reading GA4, and mapping what comes back |
| `integrations/searchConsole.ts` | The same for Search Console |
| `integrations/sheets.ts` | Four Google Sheets calls: read a range, write one, clear one, set a number format |
| `integrations/leadMirrorShared.ts` | Where the mirror's data starts and what each column means |
| `integrations/leadMirror.ts` | Reading the sheet, matching people, and planning an import |
| `integrations/leadMirrorExport.ts` | Turning the database back into the two tabs |
| `integrations/syncRunner.ts` | The part of a sync that is the same for every provider |
| `integrations/sanitize.ts` | What a failure is allowed to write down |
| `integrations/requestAuth.ts` | Who may start a sync, and whose data it runs against |

`leadMirror.ts` and `leadMirrorExport.ts` are pure. They take cell values and rows
and return a plan or a rectangle of cells, so the hard parts, deciding which person
a row is about and what a re-import would change, are tested without Google or a
database anywhere in the path.

## The intended data flow

```
Provider API  ->  server function (holds the secrets)  ->  Supabase table
                                                              |
                                                       row level security
                                                              |
                                                          browser reads
```

The browser never talks to a provider. It reads `ga4_daily_traffic`,
`search_console_daily`, `integration_connections` and `sync_runs`, all scoped to the
signed in owner.

## Running this later

A sync is expected to be a Supabase Edge Function on a schedule, reading its
secrets from the function's own environment. It uses the service role key, which
bypasses row level security, so it must set `owner_id` explicitly on every row it
writes. That is the one place in the system where getting `owner_id` wrong would
cross owners, which is why it stays small and server side.

### The one write scope

`sheets.ts` asks Google for `auth/spreadsheets`, which is read **and** write, because
the lead mirror is rewritten from the database. It is the only non-read-only scope in
the system and it should stay that way. GA4 and Search Console use
`analytics.readonly` and `webmasters.readonly`; a sync that only reads cannot damage
a property even if it is wrong.

The sheet is also the only place where data leaves this system rather than entering
it, which is why `leadMirrorExport.ts` is explicit about what never gets written: no
row id, no owner id, no connection id, no token, no service account address. A test
asserts it over a built export rather than trusting the comment.

Two rules a sync has to honour, both now enforced by the database and covered by
`npm run test:db`:

- **Upsert, never insert.** Write with `on conflict (owner_id, date, ...) do update`.
  The unique constraints in migration 0005 are the conflict target. A plain insert
  of a day already present is rejected.
- **Never delete what the provider did not mention.** Providers restate history as
  data settles. Absence from one response is not evidence that a day had no traffic.

## Before writing any of this

The database has to be set up correctly first. See
[../supabase/README.md](../supabase/README.md) for the migration order, why the seed
is not a migration, and what `npm run test:db` proves about the constraints.

One correction worth knowing about, because it shaped the schema: every composite
foreign key that clears a relationship on delete now names the column it clears.
A bare `ON DELETE SET NULL` clears the whole key, and `owner_id` is part of these
keys and is `NOT NULL`, so parent deletion was impossible. Any new table a sync adds
must follow the same pattern.
