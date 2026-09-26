/**
 * The gate every demo seed passes before its first query.
 *
 * Each service's `prisma/seed.ts` upserts fixed identifiers — `ORG-DEH-0001`,
 * `USR-SEED-*` and so on — with demo values. `pnpm db:seed` runs all of them,
 * and each one connects to whatever `DATABASE_URL_<SERVICE>` is in the
 * environment. Run by an operator whose shell holds production credentials,
 * it would overwrite real tenants with sample data, with nothing to stop it.
 *
 * So a seed runs only when all three hold:
 *
 *   1. `NODE_ENV` is explicitly `development` or `test`. Unset is refused: the
 *      platform's env schema defaults an unset NODE_ENV to `development`,
 *      which is the right default for a server's developer tooling and the
 *      wrong one for a command that writes. `staging` is refused too — it
 *      holds data somebody cares about.
 *   2. `RASTA_ALLOW_DEMO_SEED` is exactly `true`: an opt-in someone typed,
 *      separate from anything a deployment sets for other reasons.
 *   3. The database the seed is connected to says it is disposable
 *      (`assertDemoSeedDatabase`). The first two are facts about the shell;
 *      a developer's shell with both set and a `DATABASE_URL_*` pasted from
 *      production passes them. Only the target database can say what it is.
 *
 * A configuration check, not business logic (AGENTS.md A-03): it decides
 * whether a script may run, never what the script writes.
 */

/** The environments a demo seed may write into. */
export const DEMO_SEED_ENVIRONMENTS = ['development', 'test'] as const;

/** The opt-in variable. Its only accepted value is `true`. */
export const DEMO_SEED_OPT_IN = 'RASTA_ALLOW_DEMO_SEED';

/**
 * The database-level setting that marks a database as disposable.
 *
 * `infrastructure/docker/postgres/lib/disposable-marker.bash` sets it, as the
 * cluster superuser, on every service database the development and CI
 * bootstrap creates (`ALTER DATABASE … SET`). Nothing sets it anywhere else,
 * and on PostgreSQL 15+ a database's owner cannot set it for themselves: a
 * custom parameter set with `ALTER DATABASE` needs the superuser (or a
 * `GRANT SET`), so a service role cannot mark its own production database.
 */
export const DISPOSABLE_DATABASE_SETTING = 'rasta.disposable_database';

/**
 * Reads the marker from the catalog — the setting as stored for this
 * database — and not with `current_setting()`, which a client can set for its
 * own session (`options=-c rasta.disposable_database=true`) on any database.
 * `setrole = 0` is the database-wide entry, not a per-role one.
 */
export const DISPOSABLE_DATABASE_PROBE_SQL = `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_db_role_setting s
  JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = pg_catalog.current_database()
    AND s.setrole = 0
    AND '${DISPOSABLE_DATABASE_SETTING}=true' = ANY (s.setconfig)
) AS marked`;

export class DemoSeedRefusedError extends Error {
  constructor(
    readonly service: string,
    readonly reasons: readonly string[],
  ) {
    super(
      `Refusing to seed ${service}: ${reasons.join('; ')}. ` +
        `Demo seeds overwrite fixed identifiers with sample data, so they run only with ` +
        `NODE_ENV=${DEMO_SEED_ENVIRONMENTS.join('|')} and ${DEMO_SEED_OPT_IN}=true, ` +
        `against a database marked ${DISPOSABLE_DATABASE_SETTING}=true by the development ` +
        'bootstrap (infrastructure/docker/postgres). Nothing was written.',
    );
    this.name = 'DemoSeedRefusedError';
  }
}

/**
 * The reasons a seed may not run here; empty when it may.
 *
 * Never echoes a value it read — only which condition failed — so a refusal
 * printed to a shared terminal or CI log leaks nothing (S-09).
 */
export function demoSeedRefusals(env: NodeJS.ProcessEnv): string[] {
  const reasons: string[] = [];

  const nodeEnv = env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv.trim() === '') {
    reasons.push('NODE_ENV is not set');
  } else if (!(DEMO_SEED_ENVIRONMENTS as readonly string[]).includes(nodeEnv)) {
    reasons.push('NODE_ENV is not a development or test environment');
  }

  if (env[DEMO_SEED_OPT_IN] !== 'true') {
    reasons.push(`${DEMO_SEED_OPT_IN} is not "true"`);
  }

  return reasons;
}

/**
 * Throws unless a demo seed may run. Call it first in the seed's `main()`,
 * before the database client issues anything.
 */
export function assertDemoSeedAllowed(service: string, env: NodeJS.ProcessEnv = process.env): void {
  const reasons = demoSeedRefusals(env);
  if (reasons.length > 0) throw new DemoSeedRefusedError(service, reasons);
}

/** What `assertDemoSeedDatabase` needs from a client: one raw read. */
export interface DemoSeedDatabaseProbe {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

/**
 * Throws unless the database behind `client` carries the disposable marker.
 * Call it after `assertDemoSeedAllowed`, on the seed's own client, before its
 * first write.
 *
 * Re-checks the environment too, so a caller that reaches this alone still
 * refuses production. Fails closed: a probe that errors or answers in any
 * shape but `[{ marked: true }]` is a refusal. The probe's error is not
 * echoed — it can name the host or the role (S-09).
 */
export async function assertDemoSeedDatabase(
  service: string,
  client: DemoSeedDatabaseProbe,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const reasons = demoSeedRefusals(env);
  if (reasons.length > 0) throw new DemoSeedRefusedError(service, reasons);

  let rows: unknown;
  try {
    rows = await client.$queryRawUnsafe(DISPOSABLE_DATABASE_PROBE_SQL);
  } catch {
    throw new DemoSeedRefusedError(service, [
      'the target database could not be checked for the disposable-database marker',
    ]);
  }

  const marked =
    Array.isArray(rows) &&
    rows.length === 1 &&
    typeof rows[0] === 'object' &&
    rows[0] !== null &&
    (rows[0] as { marked?: unknown }).marked === true;
  if (!marked) {
    throw new DemoSeedRefusedError(service, [
      'the target database is not marked as a disposable development or test database',
    ]);
  }
}
