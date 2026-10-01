import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when both credentials are present, which is what selects the adapter. */
export const supabaseConfigured = Boolean(url && anonKey);

/**
 * Where the Edge Functions live.
 *
 * Derived from the project url rather than configured separately, so there is no
 * second value to keep in step. This is a public address, not a credential: the
 * functions decide for themselves whether the caller's session is allowed.
 */
export function functionsBaseUrl(): string {
  if (!url) throw new Error('Supabase is not configured.');
  return `${url.replace(/\/+$/, '')}/functions/v1`;
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    );
  }
  client ??= createClient(url as string, anonKey as string, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}
