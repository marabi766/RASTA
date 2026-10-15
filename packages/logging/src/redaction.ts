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
  // A client's Idempotency-Key can be guessable or carry business meaning, and
  // anyone holding it can replay the stored response (S-09).
  'idempotencyKey',

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
  paths.push('req.headers["idempotency-key"]');

  return Array.from(new Set(paths));
}

/**
 * The longest message {@link scrubMessage} reads, in UTF-16 code units. A
 * longer one is cut to it first — an error message can quote a request body
 * or header, read before any authentication — so what a message costs is
 * bounded however long it arrives. Same value as `REDACT_TEXT_MAX` in
 * `@rasta/observability`, which this package cannot import.
 */
export const SCRUB_MESSAGE_MAX = 4096;

/** What follows a message cut to {@link SCRUB_MESSAGE_MAX}. */
export const TRUNCATED_MESSAGE = '…[TRUNCATED]';

const SLASH = 0x2f; // /
const COLON = 0x3a; // :
const AT = 0x40; // @
const EQUALS = 0x3d; // =

/** Whether a UTF-16 code unit is whitespace: exactly the set `\s` matches. */
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** `\w`: ASCII letters, digits, underscore. */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/** `[A-Za-z0-9._~+/-]`: what a bearer or basic token is made of. */
function isTokenChar(code: number): boolean {
  return (
    isWordChar(code) ||
    code === 0x2e || // .
    code === 0x7e || // ~
    code === 0x2b || // +
    code === SLASH ||
    code === 0x2d // -
  );
}

/**
 * Replaces the password in every `scheme://user:password@` with
 * {@link REDACTED}. One forward pass: each `://` is looked at once and the
 * runs after it end at the next `/`, `@` or whitespace, so no character is
 * read twice. In a `cut` text a password that runs to the end may have lost
 * its `@` to the cut, so it is taken whole.
 */
function scrubConnectionStrings(text: string, cut: boolean): string {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const sep = text.indexOf('://', from);
    if (sep === -1) break;
    from = sep + 1;
    // A scheme is at least one word character, after the previous match.
    if (sep < copied + 1 || !isWordChar(text.charCodeAt(sep - 1))) continue;

    let at = sep + 3;
    const userStart = at;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code === COLON || code === AT || code === SLASH || isWhitespace(code)) break;
      at++;
    }
    if (at === userStart || text.charCodeAt(at) !== COLON) continue;
    const passwordStart = at + 1;
    at = passwordStart;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code === AT || code === SLASH || isWhitespace(code)) break;
      at++;
    }
    if (at === passwordStart) continue;
    if (text.charCodeAt(at) !== AT && !(cut && at === text.length)) continue;

    out += `${text.slice(copied, passwordStart)}${REDACTED}`;
    copied = at;
    from = at;
  }
  return copied === 0 ? text : `${out}${text.slice(copied)}`;
}

/** The length of the `Bearer` or `Basic` (any case) at `at`, or 0. */
function schemeLength(text: string, at: number): number {
  const head = text.slice(at, at + 6).toLowerCase();
  if (head === 'bearer') return 6;
  return head.startsWith('basic') ? 5 : 0;
}

/**
 * Replaces the token in every `Bearer <token>` and `Basic <token>` (any case,
 * on a word boundary) with {@link REDACTED}. One forward pass; the scheme,
 * the whitespace and the token are runs, each read once.
 */
function scrubAuthSchemes(text: string): string {
  let out = '';
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    // Only `B` and `b` start a scheme, and only after a non-word character.
    if ((code === 0x42 || code === 0x62) && (at === 0 || !isWordChar(text.charCodeAt(at - 1)))) {
      const length = schemeLength(text, at);
      if (length > 0) {
        let end = at + length;
        const spaceStart = end;
        while (end < text.length && isWhitespace(text.charCodeAt(end))) end++;
        const tokenStart = end;
        if (end > spaceStart) {
          while (end < text.length && isTokenChar(text.charCodeAt(end))) end++;
          if (end > tokenStart) {
            while (end < text.length && text.charCodeAt(end) === EQUALS) end++;
            out += `${text.slice(copied, at)}${text.slice(at, at + length)} ${REDACTED}`;
            copied = end;
            at = end;
            continue;
          }
        }
        // What lies between is whitespace or the scheme's own letters.
        at = Math.max(at + 1, end);
        continue;
      }
    }
    at++;
  }
  return copied === 0 ? text : `${out}${text.slice(copied)}`;
}

/**
 * Scrubs credentials that appear *inside* free-text strings, where key-based
 * redaction cannot reach them. The usual offender is a driver error message
 * echoing the connection string it failed to open.
 *
 * Linear in the message, with no regular expression that could backtrack. A
 * message longer than {@link SCRUB_MESSAGE_MAX} is cut to it first — never
 * between the halves of a surrogate pair — the rules fail closed at the cut,
 * and it ends in {@link TRUNCATED_MESSAGE}.
 */
export function scrubMessage(message: string): string {
  if (message.length <= SCRUB_MESSAGE_MAX) {
    return scrubAuthSchemes(scrubConnectionStrings(message, false));
  }
  const last = message.charCodeAt(SCRUB_MESSAGE_MAX - 1);
  const kept = message.slice(
    0,
    last >= 0xd800 && last <= 0xdbff ? SCRUB_MESSAGE_MAX - 1 : SCRUB_MESSAGE_MAX,
  );
  return `${scrubAuthSchemes(scrubConnectionStrings(kept, true))}${TRUNCATED_MESSAGE}`;
}
