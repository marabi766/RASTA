// -----------------------------------------------------------------------------
// The pure parts of scripts/prisma.mjs, kept here so they can be tested without
// running Prisma.
// -----------------------------------------------------------------------------

import { tryReadUrl } from '../packages/config/src/url-reader.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The refusals of this file, as fixed texts (#385 r4): each names the setting
 * or the URL component at fault, never what was written there. The URLs carry
 * credentials, and every refusal reaches stderr — `prisma.mjs` prints it, and
 * a CI or deployment log keeps it.
 */
export const MIGRATION_REFUSALS = Object.freeze({
  unreadableUrl:
    'the migrator or runtime database URL cannot be read as a URL, so the runtime role ' +
    'keeps its rights on the migration ledger; correct the URL and run again',
  runtimeRole:
    'the runtime role (the username of DATABASE_URL_<SERVICE>) is not a plain lowercase ' +
    'identifier, so it cannot be named in the ledger revoke',
  schema:
    'the schema (the schema parameter of DATABASE_URL_<SERVICE>_MIGRATOR) is not a plain ' +
    'lowercase identifier, so it cannot be named in the ledger revoke',
  statementTimeout:
    'RASTA_MIGRATION_STATEMENT_TIMEOUT is not a positive duration such as 90s or 15min',
});

/**
 * A fresh error carrying only `text`: no `cause`, and none of the properties a
 * native error adds — `new URL` puts the whole input on `.input`, which an
 * uncaught throw prints (#385 r4).
 */
const refusal = (text) => new Error(text);

/**
 * The SQL that takes the migration ledger away from a service's runtime role
 * after a migration run (D-045), or null when there is nothing to take: no
 * migrator URL, no runtime URL, or both name the same role (a service not yet
 * split, whose runtime role owns the ledger anyway).
 *
 * The ledger is `_prisma_migrations` in the migrator URL's `schema` (Prisma's
 * own rule; `public` when absent). Identifiers are quoted, and refused unless
 * they are plain lowercase names — they come from configuration, and they are
 * interpolated into SQL. Every refusal is one of {@link MIGRATION_REFUSALS}.
 */
export function ledgerRevoke({ migratorUrl, runtimeUrl }) {
  if (!migratorUrl || !runtimeUrl) return null;
  const read = readUrls(migratorUrl, runtimeUrl);
  // Thrown here, outside the catch, so nothing of the native error travels with it.
  if (read === null) throw refusal(MIGRATION_REFUSALS.unreadableUrl);
  const { migratorRole, runtime, schema } = read;
  if (migratorRole === runtime) return null;
  if (!IDENTIFIER.test(runtime)) throw refusal(MIGRATION_REFUSALS.runtimeRole);
  if (!IDENTIFIER.test(schema)) throw refusal(MIGRATION_REFUSALS.schema);
  return (
    'DO $$ BEGIN\n' +
    `  IF to_regclass('"${schema}"."_prisma_migrations"') IS NOT NULL THEN\n` +
    `    REVOKE ALL ON TABLE "${schema}"."_prisma_migrations" FROM "${runtime}";\n` +
    '  END IF;\n' +
    'END $$;\n'
  );
}

/** The parts `ledgerRevoke` needs, or null when either URL cannot be read. */
function readUrls(migratorUrl, runtimeUrl) {
  const migrator = tryReadUrl(migratorUrl);
  const runtime = tryReadUrl(runtimeUrl);
  if (migrator === null || runtime === null) return null;
  try {
    return {
      migratorRole: decodeURIComponent(migrator.username),
      runtime: decodeURIComponent(runtime.username),
      schema: migrator.searchParams.get('schema') ?? 'public',
    };
  } catch {
    // A username that is not valid percent-encoding: unreadable too.
    return null;
  }
}

/** The startup option every migration session is opened with (L7-37). */
export const UTC_SESSION_OPTION = '-c TimeZone=UTC';

/**
 * `url` with `options=-c TimeZone=UTC`, so the migration session runs in UTC
 * whatever the server's or the migrator role's default: a migration that
 * backfills a `timestamp(3)` column with `now()` or `CURRENT_TIMESTAMP` writes
 * the session's wall time, which Prisma later reads as UTC.
 *
 * A mirror of `withUtcSession` in `packages/config/src/database-session.ts`,
 * the services' copy — not an import of it, because migrations run before any
 * build (`db:migrate` has no `^build` dependency and CI migrates straight after
 * `pnpm install`), so that package's dist may not exist yet. The two are held
 * to the same output by `scripts/db-session-utc.pg.test.mjs`. Everything but
 * the `options` parameter is kept byte for byte; an earlier `-c TimeZone=…`
 * loses to this one; a URL already ending with it is returned unchanged.
 */
export function withUtcSession(url) {
  const { existing, withOptions } = splitOptions(url);
  if (existing === UTC_SESSION_OPTION || existing.endsWith(` ${UTC_SESSION_OPTION}`)) return url;
  return withOptions(existing ? `${existing} ${UTC_SESSION_OPTION}` : UTC_SESSION_OPTION);
}

/**
 * The setting a migration that bounds its own table rewrite reads its
 * `statement_timeout` from, in place of the default in the file (D-048).
 */
export const MIGRATION_STATEMENT_TIMEOUT_SETTING = 'rasta.migration_statement_timeout';

/**
 * `url` with `-c rasta.migration_statement_timeout=<value>` added to its
 * `options`: one run's override of a rewrite migration's statement timeout,
 * for a table an operator sized above the default (D-048 runbook). Unchanged
 * when `value` is empty. Refused unless a positive whole number of ms, s, min
 * or h — it becomes a startup option — with a fixed text: what was written is
 * not a number yet, so it is not repeated (#385 r4).
 */
export function withMigrationStatementTimeout(url, value) {
  if (!value) return url;
  if (!/^[1-9][0-9]*(ms|s|min|h)$/.test(value)) throw refusal(MIGRATION_REFUSALS.statementTimeout);
  const { existing, withOptions } = splitOptions(url);
  const option = `-c ${MIGRATION_STATEMENT_TIMEOUT_SETTING}=${value}`;
  return withOptions(existing ? `${existing} ${option}` : option);
}

/**
 * The `options` parameter of `url`, decoded, and a function that rebuilds
 * `url` with it replaced — everything else byte for byte.
 *
 * Refuses, as the services' copy does and before any option is read, a URL
 * with a raw control character (U+0000–U+001F, U+007F: a URL parser drops a
 * tab, CR or LF and reads another name) or with more than one `options`
 * parameter (the driver keeps only the last). The message never contains the
 * URL.
 */
function splitOptions(url) {
  if ([...url].some((char) => char <= '\u001f' || char === '\u007f')) {
    throw new Error(
      'DATABASE_URL contains a raw control character (U+0000–U+001F or U+007F), which a URL ' +
        'parser would drop or read differently from this; remove it, or percent-encode it',
    );
  }
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

  const decode = (value) => decodeURIComponent(value.replace(/\+/g, ' '));
  const isOptions = (pair) => decode(pair.split('=')[0] ?? '') === 'options';
  const written = pairs.filter(isOptions);
  if (written.length > 1) {
    // The services' text, word for word (`packages/config` DATABASE_URL_REPEATED_OPTIONS): fixed,
    // without the count (#385 r3), and pinned equal by scripts/db-session-utc.pg.test.mjs (4).
    throw new Error(
      'DATABASE_URL has more than one options parameter, and the driver keeps only the last ' +
        'one; write every startup option in a single options parameter',
    );
  }
  const [pair] = written;
  const existing =
    pair === undefined ? '' : decode(pair.slice(pair.indexOf('=') + 1 || pair.length)).trim();
  const kept = pairs.filter((pair) => !isOptions(pair));
  return {
    existing,
    withOptions: (options) =>
      `${base}?${[...kept, `options=${encodeURIComponent(options)}`].join('&')}${hash}`,
  };
}
