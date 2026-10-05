/**
 * Every database session runs in UTC (AGENTS.md § 3, L7-37).
 *
 * Most instants are `timestamp(3)` columns — `timestamp without time zone`.
 * Prisma writes those as UTC wall time and reads them back as UTC, so its own
 * writes are right whatever the session's `TimeZone`. Raw SQL is not: `now()`
 * cast into such a column stores the **session's** wall time, which Prisma
 * then reads as if it were UTC. Under a server or role whose default is, say,
 * `Asia/Tehran`, every such instant would come back 3½ hours wrong, silently.
 * The full fix is moving those columns to `timestamptz` (docs/23); until then
 * no session may run in anything but UTC.
 *
 * So the connection asks for it at startup: `options=-c TimeZone=UTC` in the
 * connection string, which PostgreSQL applies to the session before the first
 * statement and which overrides the server's, the database's and the role's
 * default. A startup parameter rather than a `SET` per query, so every pooled
 * connection gets it, and raw `$queryRaw` and interactive transactions with
 * it.
 *
 * Infrastructure, not business logic (A-03): it decides how a connection is
 * opened, never what is done on it.
 */

/** The startup option every Rasta database session is opened with. */
export const UTC_SESSION_OPTION = '-c TimeZone=UTC';

/**
 * `url` with {@link UTC_SESSION_OPTION} in its `options` parameter.
 *
 * Appended after any options the URL already carries, so an earlier
 * `-c TimeZone=…` loses (PostgreSQL applies `-c` settings in order). Idempotent:
 * a URL whose options already end with it is returned unchanged. Everything
 * but the `options` parameter is kept byte for byte — the credentials, the
 * host and every other parameter — and the option is percent-encoded, so no
 * parser can read its space as a separator.
 */
export function withUtcSession(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const pairs =
    queryAt === -1
      ? []
      : beforeHash
          .slice(queryAt + 1)
          .split('&')
          .filter(Boolean);

  const isOptions = (pair: string): boolean =>
    decodeComponent(pair.split('=')[0] ?? '') === 'options';
  const existing = pairs
    .filter(isOptions)
    .map((pair) => decodeComponent(pair.slice(pair.indexOf('=') + 1 || pair.length)))
    .join(' ')
    .trim();

  if (existing === UTC_SESSION_OPTION || existing.endsWith(` ${UTC_SESSION_OPTION}`)) return url;

  const options = existing ? `${existing} ${UTC_SESSION_OPTION}` : UTC_SESSION_OPTION;
  const kept = pairs.filter((pair) => !isOptions(pair));
  return `${base}?${[...kept, `options=${encodeURIComponent(options)}`].join('&')}${hash}`;
}

/** A query component as `application/x-www-form-urlencoded` reads it: `+` is a space. */
function decodeComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}
