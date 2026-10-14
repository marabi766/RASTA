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
import { DatabaseUrlConflictError } from './database-pool';

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
  const { existing, withOptions } = startupOptions(url);
  if (endsWithUtc(existing)) return url;
  return withOptions(existing ? `${existing} ${UTC_SESSION_OPTION}` : UTC_SESSION_OPTION);
}

/**
 * `url` with `-c statement_timeout=<timeoutMs>` in its `options` parameter: the
 * runtime session's statement timeout (`DATABASE_STATEMENT_TIMEOUT_MS`), written
 * by `loadEnv` the way the UTC option is, so every pooled connection starts
 * with it and it overrides the server's, the database's and the role's
 * default. A transaction that needs longer says so itself with `SET LOCAL`
 * (the outbox purge does), which wins inside that transaction only.
 *
 * `undefined` — the variable unset, no statement timeout (#268 r4) — returns
 * the URL unchanged, unless its options set `statement_timeout` themselves:
 * that is refused ({@link DatabaseUrlConflictError}), because a timeout written
 * only in the URL would escape the check against the service's operation
 * budgets that the variable goes through.
 *
 * Placed before a trailing {@link UTC_SESSION_OPTION}, so the URL still ends
 * with it and `withUtcSession` stays idempotent on the result. A URL whose
 * options already set `statement_timeout` to the same value is returned
 * unchanged; to another value, {@link DatabaseUrlConflictError} — one number
 * in two places is refused, as the pool's are.
 *
 * Behind PgBouncer in transaction pooling the whole `options` parameter is
 * dropped (`ignore_startup_parameters`, docs/11 § 11.2): there the timeout has
 * to be the runtime role's own default, set on the database side.
 */
export function withStatementTimeout(url: string, timeoutMs: number | undefined): string {
  const { existing, withOptions } = startupOptions(url);
  const written = settingsIn(existing).filter(([name]) => name === 'statement_timeout');
  if (timeoutMs === undefined) {
    if (written.length === 0) return url;
    throw new DatabaseUrlConflictError(
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'statement_timeout',
      'DATABASE_URL sets statement_timeout in its options while DATABASE_STATEMENT_TIMEOUT_MS is ' +
        'unset; set it with DATABASE_STATEMENT_TIMEOUT_MS instead, which is checked against the ' +
        'service’s operation budgets',
    );
  }
  if (written.some(([, value]) => value !== String(timeoutMs))) {
    throw new DatabaseUrlConflictError('DATABASE_STATEMENT_TIMEOUT_MS', 'statement_timeout');
  }
  if (written.length > 0) return url;

  const option = `-c statement_timeout=${timeoutMs}`;
  if (!existing) return withOptions(option);
  if (!endsWithUtc(existing)) return withOptions(`${existing} ${option}`);
  const before = existing.slice(0, existing.length - UTC_SESSION_OPTION.length).trim();
  return withOptions([before, option, UTC_SESSION_OPTION].filter(Boolean).join(' '));
}

function endsWithUtc(options: string): boolean {
  return options === UTC_SESSION_OPTION || options.endsWith(` ${UTC_SESSION_OPTION}`);
}

/**
 * The `options` the URL carries (every `options` parameter, joined), and a
 * function giving the URL with them replaced. Everything but the `options`
 * parameter is kept byte for byte — the credentials, the host and every other
 * parameter — and the new value is percent-encoded, so no parser can read its
 * spaces as separators.
 */
function startupOptions(url: string): {
  existing: string;
  withOptions: (options: string) => string;
} {
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
  const kept = pairs.filter((pair) => !isOptions(pair));
  return {
    existing,
    withOptions: (options) =>
      `${base}?${[...kept, `options=${encodeURIComponent(options)}`].join('&')}${hash}`,
  };
}

/**
 * The `name=value` settings in a startup `options` string, as PostgreSQL reads
 * them: `-c name=value`, `-cname=value` or `--name=value`, a name's dashes
 * read as underscores and its case ignored.
 */
function settingsIn(options: string): Array<[name: string, value: string]> {
  const words = options.split(/\s+/).filter(Boolean);
  const settings: Array<[string, string]> = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    let setting: string | undefined;
    if (word === '-c') setting = words[++i];
    else if (word.startsWith('-c')) setting = word.slice(2);
    else if (word.startsWith('--')) setting = word.slice(2);
    if (!setting) continue;
    const at = setting.indexOf('=');
    const name = (at === -1 ? setting : setting.slice(0, at)).replace(/-/g, '_').toLowerCase();
    settings.push([name, at === -1 ? '' : setting.slice(at + 1)]);
  }
  return settings;
}

/** A query component as `application/x-www-form-urlencoded` reads it: `+` is a space. */
function decodeComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}
