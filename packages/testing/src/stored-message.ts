/**
 * Absence checks over a stored message (an outbox row's `payload`), by walking it.
 *
 * Two escapes a whole-text search and a values-only walk each leave open: a marker appended to a
 * value that is otherwise expected (`"01J… intervalHours=500.00"`), and a marker carried as a
 * property NAME (`{"Very identifiable name": true}`) that schema parsing strips before anyone
 * looks. This walks every key and every string/number leaf of the RAW message, and can also pin
 * the keys the envelope may have.
 *
 * A string that is wholly a strict ISO instant is not searched: it holds only digits and `-:.TZ`,
 * so a marker cannot hide in one, and a short numeric marker such as `50.00` can occur inside a
 * real one (`…:50.001Z`) by chance (#452). Append anything to it and it stops being an instant,
 * so it is searched. Pin each such field to its exact shape at the call site.
 *
 * Imports nothing, like `disclosure.ts`.
 */

/** A strict, UTC ISO instant as `Date#toISOString` writes it (and Postgres, up to microseconds). */
export const ISO_INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export interface StoredMessageRules {
  /** Searched, case-insensitively, in every key and every string or number leaf. */
  readonly anywhere?: readonly string[];
  /** Searched, case-insensitively, in keys only (a value may legitimately name a field). */
  readonly inKeys?: readonly string[];
  /** When given, the message's own top-level keys must all be in it. */
  readonly topLevelKeys?: readonly string[];
}

/** Every way the message breaks the rules; empty means clean. Fails closed on an empty walk. */
export function storedMessageProblems(message: unknown, rules: StoredMessageRules): string[] {
  const problems: string[] = [];
  const anywhere = (rules.anywhere ?? []).map((marker) => marker.toLowerCase());
  const inKeys = (rules.inKeys ?? []).map((marker) => marker.toLowerCase());
  if (anywhere.length + inKeys.length === 0) problems.push('no markers to look for');
  if (typeof message !== 'object' || message === null) {
    return [...problems, 'the stored message is not an object'];
  }
  if (rules.topLevelKeys !== undefined) {
    for (const key of Object.keys(message)) {
      if (!rules.topLevelKeys.includes(key)) problems.push(`top-level key ${JSON.stringify(key)}`);
    }
  }
  let leaves = 0;
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        const lower = key.toLowerCase();
        for (const marker of [...anywhere, ...inKeys]) {
          if (lower.includes(marker)) problems.push(`key ${JSON.stringify(key)} at ${path}`);
        }
        visit(child, `${path}.${key}`);
      }
      return;
    }
    leaves += 1;
    if (typeof value === 'string' && ISO_INSTANT_SHAPE.test(value)) return;
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const text = String(value).toLowerCase();
    for (const marker of anywhere) {
      if (text.includes(marker)) problems.push(`value ${JSON.stringify(value)} at ${path}`);
    }
  };
  visit(message, '$');
  if (leaves === 0) problems.push('the stored message has no leaves');
  return problems;
}

/** Throws one error listing every offending key and value. */
export function expectStoredMessageWithout(message: unknown, rules: StoredMessageRules): void {
  const problems = storedMessageProblems(message, rules);
  if (problems.length > 0) {
    const error = new Error(`expectStoredMessageWithout:\n  - ${problems.join('\n  - ')}`);
    Error.captureStackTrace(error, expectStoredMessageWithout);
    throw error;
  }
}
