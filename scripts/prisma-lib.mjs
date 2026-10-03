// -----------------------------------------------------------------------------
// The pure parts of scripts/prisma.mjs, kept here so they can be tested without
// running Prisma.
// -----------------------------------------------------------------------------

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The SQL that takes the migration ledger away from a service's runtime role
 * after a migration run (D-045), or null when there is nothing to take: no
 * migrator URL, no runtime URL, or both name the same role (a service not yet
 * split, whose runtime role owns the ledger anyway).
 *
 * The ledger is `_prisma_migrations` in the migrator URL's `schema` (Prisma's
 * own rule; `public` when absent). Identifiers are quoted, and refused unless
 * they are plain lowercase names — they come from configuration, and they are
 * interpolated into SQL.
 */
export function ledgerRevoke({ migratorUrl, runtimeUrl }) {
  if (!migratorUrl || !runtimeUrl) return null;
  const migrator = new URL(migratorUrl);
  const runtime = decodeURIComponent(new URL(runtimeUrl).username);
  if (decodeURIComponent(migrator.username) === runtime) return null;
  const schema = migrator.searchParams.get('schema') ?? 'public';
  for (const [what, name] of [
    ['runtime role', runtime],
    ['schema', schema],
  ]) {
    if (!IDENTIFIER.test(name)) throw new Error(`the ${what} "${name}" is not a plain identifier`);
  }
  return (
    'DO $$ BEGIN\n' +
    `  IF to_regclass('"${schema}"."_prisma_migrations"') IS NOT NULL THEN\n` +
    `    REVOKE ALL ON TABLE "${schema}"."_prisma_migrations" FROM "${runtime}";\n` +
    '  END IF;\n' +
    'END $$;\n'
  );
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
  const existing = pairs
    .filter(isOptions)
    .map((pair) => decode(pair.slice(pair.indexOf('=') + 1 || pair.length)))
    .join(' ')
    .trim();

  if (existing === UTC_SESSION_OPTION || existing.endsWith(` ${UTC_SESSION_OPTION}`)) return url;

  const options = existing ? `${existing} ${UTC_SESSION_OPTION}` : UTC_SESSION_OPTION;
  const kept = pairs.filter((pair) => !isOptions(pair));
  return `${base}?${[...kept, `options=${encodeURIComponent(options)}`].join('&')}${hash}`;
}

/**
 * URLs both copies of `withUtcSession` must agree on — the parity corpus of
 * `scripts/db-session-utc.pg.test.mjs` and the cases of `prisma-lib.test.mjs`.
 */
export const UTC_SESSION_CORPUS = [
  'postgresql://u:p@db:5432/rasta',
  'postgresql://u:p@db:5432/rasta?schema=public',
  'postgres://u:p@db:5432/rasta?schema=audit&connection_limit=3',
  'postgresql://rasta_x:p%40ss%2Fw%3Ard!@db.internal:6432/rasta_x?schema=public&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&application_name=a+b',
  'postgresql://u:p@db/rasta?options=-c%20TimeZone%3DAsia%2FTehran&schema=public',
  'postgresql://u:p@db/rasta?options=-c+statement_timeout%3D5000',
  'postgresql://u:p@db/rasta?options=-c%20TimeZone%3DUTC',
  'postgresql://u:p@db/rasta?options=-c%20TimeZone%3DUTC%20-c%20TimeZone%3DAsia%2FTehran',
  'postgresql://u:p@db/rasta?schema=public#x',
];
