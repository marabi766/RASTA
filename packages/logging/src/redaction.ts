/**
 * Log redaction.
 *
 * Logs are retained for months and read by people who are not the data
 * subject. Anything that identifies a person, authenticates a caller, or would
 * prejudice a competitive process must never reach them.
 *
 * This list is deliberately generous. A false positive costs a redacted field
 * in a debug session; a false negative costs a disclosure that survives in log
 * storage and backups.
 */

/** Key names whose values are replaced wholesale, at any nesting depth. */
export const SENSITIVE_KEYS = [
  // credentials and tokens
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'apikey',
  'authorization',
  'cookie',
  'setCookie',
  'clientSecret',
  'privateKey',
  'credential',
  'credentials',
  'otp',
  'totp',
  'mfaCode',

  // personal identifiers
  'nationalId',
  'nationalCode',
  'melliCode',
  'passportNumber',
  'birthDate',
  'phoneNumber',
  'mobile',
  'personalEmail',

  // payment instruments — the platform never stores these, but a misrouted
  // provider response must not leak them either
  'cardNumber',
  'pan',
  'cvv',
  'cvv2',
  'iban',
  'accountNumber',
  'shebaNumber',

  // commercially confidential before a deadline passes
  'bidAmount',
  'bidContent',
  'quotationAmount',
  'sealedPayload',
] as const;

export const REDACTED = '[REDACTED]';

/**
 * pino `redact.paths` entries. Covers the key at the root, one level down, and
 * inside the request/response objects that HTTP logging attaches.
 */
export function buildRedactionPaths(): string[] {
  const paths: string[] = [];

  for (const key of SENSITIVE_KEYS) {
    paths.push(key);
    paths.push(`*.${key}`);
    paths.push(`*.*.${key}`);
    paths.push(`req.headers.${key.toLowerCase()}`);
    paths.push(`res.headers.${key.toLowerCase()}`);
    paths.push(`payload.${key}`);
    paths.push(`body.${key}`);
  }

  // Authorization headers arrive with varying casing depending on the client.
  paths.push('req.headers.authorization', 'req.headers.Authorization');
  paths.push('req.headers.cookie', 'req.headers["set-cookie"]');
  paths.push('req.headers["x-internal-token"]');

  return Array.from(new Set(paths));
}

const CONNECTION_STRING_CREDENTIALS = /(\w+:\/\/)([^:@/\s]+):([^@/\s]+)@/g;
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

/**
 * Scrubs credentials that appear *inside* free-text strings, where key-based
 * redaction cannot reach them. The usual offender is a driver error message
 * echoing the connection string it failed to open.
 */
export function scrubMessage(message: string): string {
  return message
    .replace(CONNECTION_STRING_CREDENTIALS, `$1$2:${REDACTED}@`)
    .replace(BEARER_TOKEN, `$1 ${REDACTED}`);
}
