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
| `integrations/types.ts` | Shared provider, status and run types |
| `integrations/calendar.ts` | The Google Calendar sync contract and its rules |
| `integrations/analytics.ts` | The GA4 and Search Console sync contracts |

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
