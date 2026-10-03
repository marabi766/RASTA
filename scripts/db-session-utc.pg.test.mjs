// -----------------------------------------------------------------------------
// Every database session runs in UTC (L7-37), on a real cluster.
//
//   pnpm test:db-session-utc      (a PostgreSQL superuser in PG* env; `pnpm build` first)
//
// The fixture is the failure it guards against: a throwaway role whose default
// TimeZone is Asia/Tehran (UTC+03:30), on a throwaway database it owns. A raw
// `now()` written into a `timestamp(3)` column under that session stores
// Tehran's wall time, which Prisma reads back as UTC — 3½ hours wrong. The
// control proves the fixture bites; then each way a Rasta process opens a
// connection must come out in UTC regardless:
//
//   1. a service's runtime clients — the URL `loadEnv(databaseEnvSchema)` hands
//      every PrismaService, main.ts preflight and CLI (@rasta/config, as built);
//      pooled connections, an interactive transaction and a raw instant;
//   2. the migration runner, scripts/prisma.mjs, run as `db:migrate` runs it;
//   3. the demo seeds, which resolve their own URL and pass it through the
//      same @rasta/config function (held statically here, proven in 1);
//   4. the migration runner's copy of the function agrees with the services'.
//
// Needs `psql`, a superuser (PGHOST, PGPORT, PGUSER, PGPASSWORD) and
// organization-service's generated Prisma client (any service's would do).
// -----------------------------------------------------------------------------
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { UTC_SESSION_CORPUS, withUtcSession as runnerWithUtcSession } from './prisma-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The services' function, exactly as built.
const { databaseEnvSchema, loadEnv, withUtcSession } = require(
  join(ROOT, 'packages', 'config', 'dist', 'index.js'),
);
const ORGANIZATION = join(ROOT, 'services', 'organization-service');
const { PrismaClient } = createRequire(join(ORGANIZATION, 'package.json'))(
  join(ORGANIZATION, 'src', 'generated', 'prisma'),
);

const ROLE = `rasta_tzt${process.pid}`;
const DB = ROLE;
const PASSWORD = `tz_${randomBytes(12).toString('hex')}`;
const ZONE = 'Asia/Tehran';
/** Tehran has kept UTC+03:30 all year since 2022; a wall clock that far off is the bug. */
const TEHRAN_OFFSET_MS = 3.5 * 3600 * 1000;

const host = process.env.PGHOST ?? 'localhost';
const port = process.env.PGPORT ?? '5432';
/** The role's URL as an operator would write it: nothing about time zones. */
const RAW_URL = `postgresql://${ROLE}:${PASSWORD}@${host}:${port}/${DB}?schema=public`;

function psql(sql, { asRole = false, database = DB } = {}) {
  const env = { ...process.env };
  if (asRole) Object.assign(env, { PGUSER: ROLE, PGPASSWORD: PASSWORD });
  return spawnSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database], {
    env,
    input: sql,
    encoding: 'utf8',
  });
}

function ok(sql, options) {
  const result = psql(sql, options);
  assert.equal(result.status, 0, `${sql}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Opens a client on `url`, runs `fn` with it, closes it whatever happens. */
async function withClient(url, fn) {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

const sessionZone = async (client) =>
  (await client.$queryRawUnsafe(`SELECT current_setting('TimeZone') AS tz`))[0].tz;

/** A raw `now()` into `timestamp(3)`, read back through Prisma: its distance from now, in ms. */
async function rawInstantSkew(client) {
  const [row] = await client.$queryRawUnsafe(
    `INSERT INTO instant_probe (at) VALUES (now()) RETURNING at`,
  );
  return row.at.getTime() - Date.now();
}

before(() => {
  assert.ok(process.env.PGUSER, 'PGUSER must name a superuser');
  ok(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`, { database: 'postgres' });
  ok(`CREATE DATABASE ${DB} OWNER ${ROLE}`, { database: 'postgres' });
  // The server, the database and the role could each carry the default; the
  // role's is the most specific and is what an operator's ALTER ROLE leaves.
  ok(`ALTER ROLE ${ROLE} SET TimeZone = '${ZONE}'`, { database: 'postgres' });
  ok(`CREATE TABLE instant_probe (at timestamp(3) NOT NULL)`, { asRole: true });
});

after(() => {
  psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, { database: 'postgres' });
  psql(`DROP ROLE IF EXISTS ${ROLE}`, { database: 'postgres' });
});

test('the control: the role’s own sessions run in Tehran, and a raw instant comes back 3½ hours off', async () => {
  assert.equal(ok(`SHOW TimeZone`, { asRole: true }), ZONE);
  await withClient(RAW_URL, async (client) => {
    assert.equal(await sessionZone(client), ZONE);
    const skew = await rawInstantSkew(client);
    assert.ok(
      Math.abs(skew - TEHRAN_OFFSET_MS) < 60_000,
      `expected the instant ${TEHRAN_OFFSET_MS} ms ahead, it was ${skew} ms`,
    );
  });
});

test('1. a service’s runtime URL opens every session in UTC: pooled, transactional, raw', async () => {
  const { DATABASE_URL } = loadEnv(databaseEnvSchema, { DATABASE_URL: RAW_URL });
  assert.notEqual(DATABASE_URL, RAW_URL);

  // Three pooled connections, kept busy at once, so more than one is opened.
  const pooled = `${DATABASE_URL}&connection_limit=3`;
  await withClient(pooled, async (client) => {
    const zones = await Promise.all(
      Array.from({ length: 6 }, () =>
        client.$queryRawUnsafe(
          `SELECT current_setting('TimeZone') AS tz, pg_backend_pid() AS pid, pg_sleep(0.2)::text`,
        ),
      ),
    );
    const rows = zones.map(([row]) => row);
    assert.ok(new Set(rows.map((row) => row.pid)).size > 1, 'the pool opened one connection only');
    assert.deepEqual([...new Set(rows.map((row) => row.tz))], ['UTC']);

    assert.equal(await client.$transaction((tx) => sessionZone(tx)), 'UTC');
    assert.ok(Math.abs(await rawInstantSkew(client)) < 60_000, 'a raw instant is not UTC');
  });
});

test('2. the migration runner (scripts/prisma.mjs) migrates in UTC', () => {
  const probe = `tz_migrate_${process.pid}`;
  // organization-service is split, so the runner takes the migrator variable;
  // only what it needs is passed — not this process's .env.
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'prisma.mjs'),
      'db',
      'execute',
      '--schema',
      'prisma/schema.prisma',
      '--stdin',
    ],
    {
      cwd: ORGANIZATION,
      env: {
        PATH: `${join(ORGANIZATION, 'node_modules', '.bin')}:${process.env.PATH}`,
        HOME: process.env.HOME ?? '',
        DATABASE_URL_ORGANIZATION_MIGRATOR: RAW_URL,
      },
      input: `CREATE TABLE ${probe} AS SELECT current_setting('TimeZone') AS tz, now()::timestamp(3) AS at;`,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(ok(`SELECT tz FROM ${probe}`, { asRole: true }), 'UTC');
  const skewSeconds = Number(
    ok(`SELECT extract(epoch FROM (at - (now() AT TIME ZONE 'UTC')))::int FROM ${probe}`, {
      asRole: true,
    }),
  );
  assert.ok(Math.abs(skewSeconds) < 60, `the migration wrote an instant ${skewSeconds} s off UTC`);
});

test('3. every demo seed opens its database through withUtcSession', () => {
  const seeds = readdirSync(join(ROOT, 'services'))
    .map((service) => join(ROOT, 'services', service, 'prisma', 'seed.ts'))
    .filter((file) => existsSync(file));
  assert.ok(seeds.length > 0, 'no seed found');
  for (const file of seeds) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('new PrismaClient(')) continue;
    assert.match(
      source,
      /function resolveDatabaseUrl\([\s\S]*?return withUtcSession\(url\);\n\}/,
      `${file}: resolveDatabaseUrl must return withUtcSession(url)`,
    );
    assert.match(source, /import \{[^}]*\bwithUtcSession\b[^}]*\} from '@rasta\/config'/);
    // Every client the seed opens takes that URL, and no other.
    const clients = source.match(/new PrismaClient\(\{[^)]*\}\)/g) ?? [];
    for (const client of clients) {
      assert.match(client, /url: resolveDatabaseUrl\(\)|\{ url \}/, `${file}: ${client}`);
    }
  }
  // …and that function is the one proven in test 1.
  assert.equal(
    withUtcSession(RAW_URL),
    loadEnv(databaseEnvSchema, { DATABASE_URL: RAW_URL }).DATABASE_URL,
  );
});

test('4. the migration runner’s copy and the services’ agree', () => {
  for (const url of [...UTC_SESSION_CORPUS, RAW_URL]) {
    assert.equal(runnerWithUtcSession(url), withUtcSession(url), url);
  }
});
