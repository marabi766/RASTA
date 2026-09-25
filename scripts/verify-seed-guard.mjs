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
 *   - NODE_ENV=development without the opt-in.
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
 * must not move. `psql` must be on PATH. Nothing here runs a seed that is
 * allowed to write.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
];

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

function snapshot(url) {
  // psql does not understand Prisma's `?schema=` parameter; pass it as the
  // search_path instead, so current_schema() is the schema the seed writes.
  const parsed = new URL(url);
  const schema = parsed.searchParams.get('schema') ?? 'public';
  parsed.search = '';
  const result = spawnSync(
    'psql',
    [parsed.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', SNAPSHOT_SQL],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` } },
  );
  if (result.status !== 0) {
    throw new Error(`snapshot failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
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

for (const service of SERVICES) {
  const urlKey = `DATABASE_URL_${service.toUpperCase()}`;
  const url = withDatabase ? process.env[urlKey] : CLOSED_PORT_URL;
  if (!url) {
    failures.push(`${service}: ${urlKey} is not set (required with --with-database)`);
    continue;
  }

  for (const { label, env } of CASES) {
    const before = withDatabase ? snapshot(url) : null;
    const result = runSeed(service, { ...env, [urlKey]: url, DATABASE_URL: url });
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
  `\n✓ seed guard: ${checks} refusal(s) across ${SERVICES.length} seeds` +
    (withDatabase ? ', every database snapshot unchanged' : ', each before any connection'),
);
