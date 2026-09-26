#!/usr/bin/env node
/**
 * Proves every demo seed refuses to run outside an explicit development or
 * test run, and refuses **before it writes anything**.
 *
 *   node scripts/verify-seed-guard.mjs                    # no database needed
 *   node scripts/verify-seed-guard.mjs --with-database    # + row snapshots
 *
 * Runs each service's own `db:seed` package script — the entry point an
 * operator would run — under the conditions that must be refused:
 *
 *   - NODE_ENV=production, even with RASTA_ALLOW_DEMO_SEED=true;
 *   - NODE_ENV=development without the opt-in;
 *   - NODE_ENV=development with the opt-in, against a database that does not
 *     carry the disposable marker (`rasta.disposable_database`, set only by
 *     the development/CI bootstrap). Without a database that is the closed
 *     port — a database that cannot be asked is refused too; with one, it is
 *     the same server's `postgres` database, reached with the service's own
 *     credentials.
 *
 * Each run must exit non-zero with the guard's refusal.
 *
 * Without a database, every seed is pointed at a closed port. A seed that
 * reached for the database before checking would fail with a connection
 * error instead of the refusal, so the refusal itself proves the check comes
 * first.
 *
 * With `--with-database`, each seed gets its real `DATABASE_URL_<SERVICE>`,
 * and a checksum of every row in every table is taken before and after: it
 * must not move. It also proves the marker itself against PostgreSQL: the
 * guard's probe answers true on the service's database and false on
 * `postgres`, a client-side `-c rasta.disposable_database=true` does not fool
 * it, and the service role cannot set the marker on its own database. `psql`
 * must be on PATH. Nothing here runs a seed that is allowed to write.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = [
  'asset',
  'economic',
  'fleet',
  'identity',
  'maintenance',
  'marketplace',
  'organization',
];
const withDatabase = process.argv.includes('--with-database');
const CLOSED_PORT_URL = 'postgresql://seed_guard:unused@127.0.0.1:1/seed_guard_unreachable';

const CASES = [
  {
    label: 'NODE_ENV=production with the opt-in',
    env: { NODE_ENV: 'production', RASTA_ALLOW_DEMO_SEED: 'true' },
  },
  {
    label: 'NODE_ENV=development without the opt-in',
    env: { NODE_ENV: 'development', RASTA_ALLOW_DEMO_SEED: '' },
  },
  {
    label: 'NODE_ENV=development with the opt-in, database not marked disposable',
    env: { NODE_ENV: 'development', RASTA_ALLOW_DEMO_SEED: 'true' },
    unmarked: true,
  },
];

/** The same server and credentials, but the `postgres` database: never marked. */
function unmarkedSibling(url) {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/**
 * One checksum per table in the connection's schema: row count and an md5 of
 * every row, ordered. `query_to_xml` runs the per-table query without needing
 * a function created in the database under test.
 */
const SNAPSHOT_SQL = `
  SELECT t.table_name || ' ' ||
         (xpath('/row/c/text()', query_to_xml(format(
           'SELECT count(*) || '':'' || md5(coalesce(string_agg(r::text, ''|'' ORDER BY r::text), '''')) AS c FROM %I.%I r',
           t.table_schema, t.table_name), false, true, '')))[1]::text
  FROM information_schema.tables t
  WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
  ORDER BY t.table_name;`;

function psql(url, sql, extraOptions = '') {
  // psql does not understand Prisma's `?schema=` parameter; pass it as the
  // search_path instead, so current_schema() is the schema the seed writes.
  const parsed = new URL(url);
  const schema = parsed.searchParams.get('schema') ?? 'public';
  parsed.search = '';
  return spawnSync('psql', [parsed.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql], {
    encoding: 'utf8',
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema} ${extraOptions}`.trim() },
  });
}

function snapshot(url) {
  const result = psql(url, SNAPSHOT_SQL);
  if (result.status !== 0) {
    throw new Error(`snapshot failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * The guard's own probe and setting name, from the built @rasta/config — the
 * code the seeds run — so this cannot drift from it. The seeds need the build
 * as well (`@rasta/config` resolves to its dist).
 */
async function loadGuard() {
  const dist = resolve(ROOT, 'packages/config/dist/seed-guard.js');
  if (!existsSync(dist)) {
    throw new Error('packages/config is not built: run `pnpm --filter @rasta/config build`');
  }
  const guard = await import(pathToFileURL(dist).href);
  return {
    probe: guard.DISPOSABLE_DATABASE_PROBE_SQL,
    setting: guard.DISPOSABLE_DATABASE_SETTING,
  };
}

/**
 * The marker against a real server, with the service's credentials: marked
 * here, not marked on `postgres`, not spoofable from the client, and not
 * settable by the service role on its own database.
 */
function markerProblems(service, url, { probe, setting }) {
  const problems = [];
  const ask = (target, extraOptions) => {
    const result = psql(target, probe, extraOptions);
    return result.status === 0 ? result.stdout.trim() : `error: ${result.stderr.trim()}`;
  };

  const own = ask(url);
  if (own !== 't') problems.push(`${service}: its database is not marked disposable (${own})`);

  const other = ask(unmarkedSibling(url));
  if (other !== 'f') problems.push(`${service}: the postgres database answered ${other}`);

  const spoofed = ask(unmarkedSibling(url), `-c ${setting}=true`);
  if (spoofed !== 'f') {
    problems.push(`${service}: a session-level ${setting} fooled the probe (${spoofed})`);
  }

  const database = new URL(url).pathname.slice(1);
  const self = psql(url, `ALTER DATABASE "${database}" SET ${setting} = 'true'`);
  if (self.status === 0) {
    problems.push(`${service}: the service role could set ${setting} on its own database`);
  } else if (!/permission denied/i.test(self.stderr)) {
    problems.push(
      `${service}: setting the marker failed, but not as refused: ${self.stderr.trim()}`,
    );
  }
  return problems;
}

function runSeed(service, env) {
  return spawnSync('pnpm', ['--filter', `@rasta/${service}-service`, 'run', 'db:seed'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const failures = [];
let checks = 0;
const guard = withDatabase ? await loadGuard() : null;

for (const service of SERVICES) {
  const urlKey = `DATABASE_URL_${service.toUpperCase()}`;
  const url = withDatabase ? process.env[urlKey] : CLOSED_PORT_URL;
  if (!url) {
    failures.push(`${service}: ${urlKey} is not set (required with --with-database)`);
    continue;
  }

  if (withDatabase) {
    const problems = markerProblems(service, url, guard);
    failures.push(...problems);
    checks += 1;
    if (problems.length === 0) {
      console.log(`  ✓ ${service}: marker set, read from the catalog, not settable by the service`);
    }
  }

  for (const { label, env, unmarked } of CASES) {
    const target = unmarked && withDatabase ? unmarkedSibling(url) : url;
    const before = withDatabase ? snapshot(url) : null;
    const result = runSeed(service, { ...env, [urlKey]: target, DATABASE_URL: target });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    checks += 1;

    if (result.status === 0) {
      failures.push(`${service}, ${label}: the seed exited 0`);
      continue;
    }
    if (!output.includes(`Refusing to seed ${service}-service`)) {
      failures.push(
        `${service}, ${label}: exited ${result.status} but not with the guard's refusal ` +
          '(a seed that fails on the database instead reached it before checking):\n' +
          output
            .split('\n')
            .slice(-8)
            .map((line) => `    ${line}`)
            .join('\n'),
      );
      continue;
    }
    if (withDatabase) {
      const after = snapshot(url);
      if (after !== before) {
        failures.push(`${service}, ${label}: refused, but the database changed`);
        continue;
      }
    }
    console.log(`  ✓ ${service}: refused — ${label}${withDatabase ? ', rows unchanged' : ''}`);
  }
}

if (failures.length > 0) {
  console.error(`\n✗ seed guard: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `\n✓ seed guard: ${checks} check(s) across ${SERVICES.length} seeds` +
    (withDatabase
      ? ', every marker proven, every database snapshot unchanged'
      : ', the environment refusals before any connection'),
);
