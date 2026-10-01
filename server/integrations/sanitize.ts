/**
 * What a sync is allowed to write down when something goes wrong.
 *
 * error_summary in sync_runs is readable by the signed in owner, and logs are
 * readable by anyone who can open the Supabase dashboard. Google's own error
 * responses quote back what you sent, which on a bad auth attempt can include an
 * assertion, and a token pasted into an error message is a leaked token no matter
 * how it got there.
 *
 * This module is deliberately blunt. It would rather redact an innocent string
 * than let a credential through, because the cost of the two mistakes is not the
 * same.
 */

/** Substrings that mean the surrounding text should not be stored as-is. */
const SECRET_KEYS = [
  'access_token', 'refresh_token', 'id_token', 'client_secret', 'private_key',
  'assertion', 'authorization', 'bearer', 'api_key', 'apikey', 'service_role',
  'password', 'credential', 'signature',
];

/** Shapes that are a secret regardless of what they are labelled. */
const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // PEM blocks, private keys above all.
  { pattern: /-----BEGIN[\s\S]*?END[^-]*-----/g, replacement: '[redacted key]' },
  // JWTs and Google assertions: three base64url segments.
  { pattern: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '[redacted token]' },
  // Google OAuth token shapes.
  { pattern: /\bya29\.[A-Za-z0-9._-]+/g, replacement: '[redacted token]' },
  { pattern: /\b1\/\/[A-Za-z0-9._-]{20,}/g, replacement: '[redacted token]' },
  // Anything that named itself: key="value", key: value, key=value.
  {
    pattern: new RegExp(`\\b(${SECRET_KEYS.join('|')})\\b\\s*[:=]\\s*"?[^"',;\\s}]+"?`, 'gi'),
    replacement: '$1=[redacted]',
  },
];

export const MAX_ERROR_SUMMARY = 500;

/**
 * Reduce anything at all to a short, storable sentence with no credentials in it.
 *
 * Accepts unknown rather than Error because a catch block receives whatever was
 * thrown, which for a rejected fetch is often a plain object.
 */
export function sanitizeError(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    text = error.message || error.name || 'Error';
  } else if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return truncate(redact(text));
}

/** Strip every known secret shape out of free text. */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return 'Unknown error';
  return collapsed.length <= MAX_ERROR_SUMMARY
    ? collapsed
    : `${collapsed.slice(0, MAX_ERROR_SUMMARY - 1)}…`;
}

/**
 * A console.log that cannot print a credential.
 *
 * Every sync logs through this rather than console directly, so there is one
 * place to audit rather than one per call site.
 */
export function safeLog(message: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` ${redact(String(
    typeof detail === 'string' ? detail : safeStringify(detail),
  ))}`;
  console.log(`${redact(message)}${suffix}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}
