import { RastaError } from '@rasta/nest-common';

/**
 * Refuses a request path that the upstream call would resolve differently
 * from the gateway (L1-04).
 *
 * The gateway picks the route — and with it the rate limit, the role filter
 * and the Idempotency-Key requirement — from the raw path. It then forwards
 * with `fetch`, whose URL parser removes dot-segments. So
 * `/v1/users/../audit-corrections` was checked as `users` and delivered as
 * `audit-corrections`, past that route's `SYSTEM_ADMIN` filter and its
 * idempotency requirement, on the `users` budget.
 *
 * The rule is the WHATWG URL Standard's own, so nothing it would rewrite gets
 * through:
 *
 *  - a single-dot segment is `.` or `%2e`; a double-dot segment is `..`,
 *    `.%2e`, `%2e.` or `%2e%2e` — ASCII case-insensitive (§ 4.4, path state);
 *  - for http(s), `\` is a path separator, so a backslash — raw, or `%5c` —
 *    can build a dot-segment the `/` split does not see.
 *
 * Refused rather than normalised: a normalised path would be one no client
 * sends and no log records, and a legitimate client never sends these.
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const BACKSLASH = /\\|%5c/i;

export function assertCanonicalPath(path: string): void {
  const offending =
    BACKSLASH.test(path) || path.split('/').some((segment) => DOT_SEGMENT.test(segment));
  if (!offending) return;

  throw RastaError.validation([
    {
      path: 'path',
      message: 'The request path must not contain dot-segments or backslashes',
      code: 'non_canonical_path',
    },
  ]);
}

/**
 * Refuses a request target containing a literal `#`.
 *
 * A fragment is never sent by a conforming client, but a raw socket can put
 * one in the request line, and the two sides read it differently: the route
 * is chosen from Express's path — `/v1/assets/X#/status` routes as `assets` —
 * while `fetch` treats `#` as the start of a fragment and forwards only
 * `/v1/assets/X`. The check reads `originalUrl`, the target as received, so a
 * `#` in the query is caught too. `%23` is an escaped character, not a
 * fragment, and both sides agree on it.
 */
export function assertNoFragment(originalUrl: string): void {
  if (!originalUrl.includes('#')) return;

  throw RastaError.validation([
    {
      path: 'path',
      message: 'The request target must not contain a fragment (#)',
      code: 'fragment_in_target',
    },
  ]);
}
