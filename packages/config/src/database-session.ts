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
  const written = statementTimeoutsIn(existing);
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
  if (written.includes(undefined)) {
    throw new DatabaseUrlConflictError(
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'statement_timeout',
      'DATABASE_URL names statement_timeout in its options in a form this cannot read; set it ' +
        'only with DATABASE_STATEMENT_TIMEOUT_MS',
    );
  }
  if (written.some((value) => value !== String(timeoutMs))) {
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
 * Every value a startup `options` string gives `statement_timeout`, and
 * `undefined` for each mention of it that is not read as one: refused like a
 * different value, so a spelling the server accepts and this does not know
 * still never passes (Codex r4 on #268, F1). A mention is the name anywhere in
 * the unescaped words, case ignored and dashes read as underscores.
 */
function statementTimeoutsIn(options: string): Array<string | undefined> {
  const words = startupWords(options);
  const values = settingsIn(words)
    .filter(([name]) => name === 'statement_timeout')
    .map(([, value]) => value);
  const mentions = normalisedName(words.join(' ')).split('statement_timeout').length - 1;
  return mentions > values.length ? [...values, undefined] : values;
}

/**
 * A startup `options` string split into words as the server splits it
 * (`pg_split_opts`): at unescaped ASCII whitespace, a backslash taking the next
 * character literally — so `-c statement\_timeout=1000` is
 * `statement_timeout`, and `\ ` a space inside a word.
 */
function startupWords(options: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let escaped = false;
  for (const char of options) {
    if (!escaped && /[ \t\n\v\f\r]/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (!escaped && char === '\\') {
      escaped = true;
      word ??= '';
    } else {
      escaped = false;
      word = (word ?? '') + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The server's command-line flags that take an argument (`postgres.c`,
 * `process_postgres_switches`: `B:bC:c:D:d:EeFf:h:ijk:lN:nOPp:r:S:sTt:v:W:-:`).
 */
const FLAGS_WITH_AN_ARGUMENT = new Set('BCcDdfhkNprStvW-');

/**
 * The `name=value` settings in the words, read as the server reads them, with
 * getopt: `-c name=value`, `-cname=value`, `--name=value`, and either after
 * flags that take no argument (`-ec name=value`). A name's dashes are read as
 * underscores and its case ignored.
 */
function settingsIn(words: string[]): Array<[name: string, value: string]> {
  const settings: Array<[string, string]> = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    if (word === '--') break; // getopt: the end of the flags
    if (!word.startsWith('-')) continue;
    for (let at = 1; at < word.length; at += 1) {
      const flag = word[at] ?? '';
      if (!FLAGS_WITH_AN_ARGUMENT.has(flag)) continue;
      const argument = at + 1 < word.length ? word.slice(at + 1) : words[++i];
      if ((flag === 'c' || flag === '-') && argument) {
        const eq = argument.indexOf('=');
        settings.push([
          normalisedName(eq === -1 ? argument : argument.slice(0, eq)),
          eq === -1 ? '' : argument.slice(eq + 1),
        ]);
      }
      break;
    }
  }
  return settings;
}

function normalisedName(name: string): string {
  return name.replace(/-/g, '_').toLowerCase();
}

/** A query component as `application/x-www-form-urlencoded` reads it: `+` is a space. */
function decodeComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}
