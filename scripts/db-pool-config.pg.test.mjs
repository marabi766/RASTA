// -----------------------------------------------------------------------------
// The runtime pool comes from configuration, on a real cluster.
//
//   pnpm test:db-pool-config      (any PostgreSQL login in PG* env; `pnpm build` first)
//
// `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT_SECONDS` reach Prisma only as
// `connection_limit` and `pool_timeout` in the URL `loadEnv(databaseEnvSchema)`
// hands every service (@rasta/config, as built). Unit tests hold the string;
// these hold what a client opened on it actually does:
//
//   1. unset, the pool is Prisma's default — more than two connections under a
//      burst — so nothing changes for a service that configures nothing;
//   2. DATABASE_POOL_SIZE=2: the same burst opens two, no more;
//   3. DATABASE_POOL_TIMEOUT_SECONDS=1: a query that cannot get a connection
//      fails with P2024 after about a second, where the default waits on;
//   4. every service opens its database on that URL and no other: each
//      PrismaService is built from `env.DATABASE_URL`, and so is every other
//      client in services/*/src (main.ts preflight, CLIs).
//
// Reads only: it opens connections and sleeps on them, and creates nothing.
// Needs organization-service's generated Prisma client (any service's would do).
// No assertion message carries the URL: it holds the login's password.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The services' loader, exactly as built.
const { databaseEnvSchema, loadEnv } = require(
  join(ROOT, 'packages', 'config', 'dist', 'index.js'),
);
const ORGANIZATION = join(ROOT, 'services', 'organization-service');
const { PrismaClient } = createRequire(join(ORGANIZATION, 'package.json'))(
  join(ORGANIZATION, 'src', 'generated', 'prisma'),
);

const host = process.env.PGHOST ?? 'localhost';
const port = process.env.PGPORT ?? '5432';
const login = encodeURIComponent(process.env.PGUSER ?? '');
const secret = encodeURIComponent(process.env.PGPASSWORD ?? '');
const database = process.env.PGDATABASE ?? 'postgres';
/** The URL as an operator writes it: nothing about the pool. */
const RAW_URL = `postgresql://${login}:${secret}@${host}:${port}/${database}?schema=public`;

/** What a service would connect with, given these pool variables. */
const serviceUrl = (pool = {}) =>
  loadEnv(databaseEnvSchema, { DATABASE_URL: RAW_URL, ...pool }).DATABASE_URL;

/** Opens a client on `url`, runs `fn` with it, closes it whatever happens. */
async function withClient(url, fn) {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    await client.$connect();
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

/** How many backends a burst of `queries` concurrent sleeps is spread over. */
async function backendsUnderBurst(client, queries = 8) {
  const rows = await Promise.all(
    Array.from({ length: queries }, () =>
      client.$queryRawUnsafe(`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text`),
    ),
  );
  return new Set(rows.map(([row]) => row.pid)).size;
}

test('1. unset, the pool is Prisma’s default: a burst opens more than two connections', async () => {
  assert.ok(process.env.PGUSER, 'PGUSER must name a login');
  const url = serviceUrl();
  assert.ok(!/[?&](connection_limit|pool_timeout)=/.test(url), 'the URL gained a pool parameter');
  // Prisma's default is num_physical_cpus * 2 + 1, so at least three.
  const backends = await withClient(url, (client) => backendsUnderBurst(client));
  assert.ok(backends > 2, `the default pool opened ${backends} connection(s)`);
});

test('2. DATABASE_POOL_SIZE=2: the same burst opens two connections, no more', async () => {
  const backends = await withClient(serviceUrl({ DATABASE_POOL_SIZE: '2' }), (client) =>
    backendsUnderBurst(client),
  );
  assert.equal(backends, 2);
});

/**
 * One connection held by a 4-second sleep, then a second query: with no free
 * connection it waits `pool_timeout` and fails, or gets the connection when
 * the sleep ends. Returns how it ended and how long it took.
 */
async function queryBehindHeldConnection(url) {
  return withClient(url, async (client) => {
    const held = Promise.resolve(client.$queryRawUnsafe(`SELECT pg_sleep(4)::text`));
    await sleep(300);
    const started = Date.now();
    let code = 'OK';
    try {
      await client.$queryRawUnsafe(`SELECT 1::int AS one`);
    } catch (error) {
      code = error?.code ?? error?.name ?? 'UNKNOWN';
    }
    const waitedMs = Date.now() - started;
    await held;
    return { code, waitedMs };
  });
}

test('3. DATABASE_POOL_TIMEOUT_SECONDS=1: no free connection fails with P2024 after about a second', async () => {
  const bounded = await queryBehindHeldConnection(
    serviceUrl({ DATABASE_POOL_SIZE: '1', DATABASE_POOL_TIMEOUT_SECONDS: '1' }),
  );
  assert.equal(bounded.code, 'P2024');
  assert.ok(
    bounded.waitedMs >= 800 && bounded.waitedMs < 3000,
    `it failed after ${bounded.waitedMs} ms`,
  );

  // The control: the default wait (10 s) outlasts the sleep, so the same query
  // gets the connection when it is released.
  const unbounded = await queryBehindHeldConnection(serviceUrl({ DATABASE_POOL_SIZE: '1' }));
  assert.equal(unbounded.code, 'OK');
  assert.ok(unbounded.waitedMs >= 3000, `it waited only ${unbounded.waitedMs} ms`);
});

/** Every non-test TypeScript file under `dir`. */
function sources(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !/\.(spec|int-spec|test)\.ts$/.test(file))
    .filter((file) => !file.split('/').includes('generated'))
    .map((file) => join(dir, file));
}

test('4. every service opens its database on loadEnv’s DATABASE_URL, and no other', () => {
  const services = readdirSync(join(ROOT, 'services')).filter((service) =>
    existsSync(join(ROOT, 'services', service, 'src', 'prisma', 'prisma.service.ts')),
  );
  assert.ok(services.length >= 14, `only ${services.length} services with a database found`);

  for (const service of services) {
    const src = join(ROOT, 'services', service, 'src');
    const env = readFileSync(join(src, 'config', 'env.ts'), 'utf8');
    assert.match(
      env,
      /\.merge\(databaseEnvSchema\)/,
      `${service}: env schema lacks databaseEnvSchema`,
    );
    assert.match(env, /\bloadEnv\(/, `${service}: env is not loaded through loadEnv`);

    let built = 0;
    for (const file of sources(src)) {
      const source = readFileSync(file, 'utf8');
      const where = relative(ROOT, file);
      const own = file === join(src, 'prisma', 'prisma.service.ts');
      for (const [, url] of source.matchAll(/new PrismaClient\(\{[\s\S]*?\burl: ([\w.]+)/g)) {
        // PrismaService takes its URL as a constructor argument; everything
        // else (main.ts preflight, CLIs) passes the loaded one directly.
        assert.equal(url, own ? 'databaseUrl' : 'env.DATABASE_URL', `${where}: PrismaClient url`);
      }
      assert.equal(
        (source.match(/new PrismaClient\(/g) ?? []).length,
        [...source.matchAll(/new PrismaClient\(\{[\s\S]*?\burl: /g)].length,
        `${where}: a PrismaClient without an explicit url`,
      );
      for (const [, url] of source.matchAll(/new PrismaService\(([^)]*)\)/g)) {
        assert.equal(url, 'env.DATABASE_URL', `${where}: PrismaService url`);
        built += 1;
      }
    }
    assert.ok(built >= 1, `${service}: no PrismaService built from env.DATABASE_URL`);
  }
});
