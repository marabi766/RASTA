// -----------------------------------------------------------------------------
// FU-023: every refusal the repository raises itself reports its own closed
// code through the shared CLI reporter (`command refused (code <code>)`), and
// anything else still reports the generic line and nothing more.
//
// One test per registered code, each driving the real guard (library function
// or built entry point) rather than constructing the error. The last test
// proves the registry and this file agree: a code added without a test, or a
// test for an unregistered code, fails it. Needs the services built (`dist/`),
// like the other disclosure suites.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  REFUSAL_CODES,
  commandFailure,
  markRefusal,
} from '../packages/config/src/command-failure.js';
import { KEY_SENTINELS, SENTINELS, assertNoSentinel } from './refusal-probes.mjs';
import {
  B2RefusalError,
  assertEnvironment,
  assignBatchSql,
  b1PreconditionSql,
  counterUpsertSql,
  headMaintenanceSql,
  parseOptions,
  planSql,
  resolveDatabaseUrl,
  runServiceBackfill,
  vacuumFactsSql,
  verifySql,
} from './outbox-b2-lib.mjs';
import { parseVacuumOptions, vacuumService } from './outbox-b2-vacuum.mjs';
import { prismaPort } from './outbox-b2-prisma-port.mjs';
import { authoredFiles } from './authored-source-inventory.cjs';

const root = resolve(import.meta.dirname, '..');

const TAIL = 'diagnostics withheld; prior work may have committed — reconcile before retrying';
const refused = (code) => `command refused (code ${code}); ${TAIL}`;
const GENERIC = `command failed (code unknown); ${TAIL}`;

const covered = new Set();

/** `fn` (sync or async) refuses, and the reporter names exactly `code`. */
async function assertRefusal(code, fn) {
  covered.add(code);
  let thrown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${code}: the guard did not refuse`);
  assert.equal(commandFailure(thrown), refused(code));
}

/** A built CLI run with `args`: exit `exit`, and stderr is the one closed line for `code`. */
function assertCliRefusal(code, entry, args, exit) {
  covered.add(code);
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, exit, result.stdout + result.stderr);
  assert.equal(result.stderr, `${refused(code)}\n`);
  assertNoSentinel(result.stdout + result.stderr, entry);
}

/**
 * A guard from a built package (`dist/`), run in a child so the build is loaded
 * as the CLIs load it; the child reports through the *source* reporter, so a
 * pass also proves both module copies share one registry.
 */
function assertBuiltRefusal(code, body) {
  covered.add(code);
  const script = `
    const { commandFailure } = require('./packages/config/src/command-failure.js');
    (async () => { ${body} })().then(
      () => process.stdout.write('no refusal'),
      (error) => process.stdout.write(commandFailure(error)),
    );`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, refused(code), result.stderr);
  assertNoSentinel(result.stdout + result.stderr, code);
}

// --- usage -------------------------------------------------------------------

test('usage: B2 backfill and vacuum option parsers', async () => {
  await assertRefusal('usage', () => parseOptions([`--${SENTINELS[0]}`], {}));
  await assertRefusal('usage', () => parseOptions(['--service', SENTINELS[1]], {}));
  await assertRefusal('usage', () => parseVacuumOptions([`--${SENTINELS[0]}`], {}));
  await assertRefusal('usage', () => parseVacuumOptions([], {}));
});

for (const [entry, exit] of [
  ['services/asset-service/dist/insurance/reproject.cli.js', 2],
  ['services/asset-service/dist/insurance/drain-check.cli.js', 2],
  ['services/asset-service/dist/outbox/flush.cli.js', 2],
  ['services/fleet-service/dist/fleet/clear-transferred.cli.js', 2],
  ['services/fleet-service/dist/fleet/drain-check.cli.js', 2],
  ['services/identity-service/dist/keycloak/projection.cli.js', 2],
  ['services/economic-service/dist/transaction/resolved-dispute-backfill.cli.js', 1],
  ['services/marketplace-service/dist/ops/hold-deadline-backfill.cli.js', 1],
]) {
  test(`usage: ${entry} refuses its command line by code, exit ${exit}`, () => {
    assertCliRefusal('usage', entry, [`--${SENTINELS[0]}`, SENTINELS[1]], exit);
  });
}

// #673 r1 F2: a valid command prefix does not license the rest of the line.
// Each would otherwise reach the environment, the database or Keycloak (an
// empty environment then refuses with another code, so the mutant is seen).
for (const args of [
  ['backfill', '--dry-run'],
  ['backfill', '--organization', SENTINELS[1]],
  ['reconcile', `--${SENTINELS[0]}`],
  ['reconcile', 'backfill'],
]) {
  test(`usage: projection.cli.js ${args.join(' ')} — trailing argument refused, exit 2`, () => {
    assertCliRefusal('usage', 'services/identity-service/dist/keycloak/projection.cli.js', args, 2);
  });
}

test('usage: B2 parsers refuse an unsupported argument after a valid prefix', async () => {
  await assertRefusal('usage', () =>
    parseOptions(['--service', 'document', '--apply', `--${SENTINELS[0]}`], {}),
  );
  await assertRefusal('usage', () => parseOptions(['--service', 'document', SENTINELS[1]], {}));
  await assertRefusal('usage', () =>
    parseVacuumOptions(['--service', 'document', `--${SENTINELS[0]}`], {}),
  );
});

// --- environment and credentials ---------------------------------------------

test('node-env: B2 interlock refuses production and an unrecognised NODE_ENV', async () => {
  await assertRefusal('node-env', () => assertEnvironment({ NODE_ENV: 'production' }));
  await assertRefusal('node-env', () => assertEnvironment({ NODE_ENV: SENTINELS[0] }));
});

test('owner-credential: the built guard is reported by the source reporter (one registry)', () => {
  assertBuiltRefusal(
    'owner-credential',
    `require('./packages/config/dist/index.js').assertNoMigratorCredentials({
      DATABASE_URL_${KEY_SENTINELS[0]}_MIGRATOR: 'x',
    });`,
  );
});

test('configuration: a service environment that does not validate', () => {
  assertBuiltRefusal(
    'configuration',
    `require('./services/asset-service/dist/config/env.js').loadAssetEnv({ PORT: '${SENTINELS[0]}' });`,
  );
});

test('database-url-unset: B2 backfill and vacuum without a per-service URL', async () => {
  await assertRefusal('database-url-unset', () => resolveDatabaseUrl('document', {}));
  // The vacuum resolves its URL inside its loop; drive the real CLI.
  covered.add('database-url-unset');
  const run = spawnSync(
    process.execPath,
    ['scripts/outbox-b2-vacuum.mjs', '--service', 'document'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    },
  );
  assert.equal(run.status, 1);
  const event = run.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((e) => e.type === 'refused');
  assert.equal(event.reason, refused('database-url-unset'));
});

// --- runtime role ------------------------------------------------------------

const facts = JSON.stringify({
  role: 'rasta_document',
  sessionRole: 'rasta_document',
  database: 'rasta',
  superuser: true,
  createDb: false,
  createRole: false,
  bypassRls: false,
  replication: false,
  ownsDatabase: false,
  ownedSchemas: [],
  ownsRelationIn: [],
  createOnDatabase: false,
  createOnSchemas: [],
  memberOf: [],
});
const preflight = (open) => `
  await require('./packages/nest-common/dist/index.js').preflightRuntimeRole(${open}, {
    service: 'probe',
    runtimeVariable: 'DATABASE_URL_DOCUMENT',
  });`;

test('runtime-role: the preflight refuses a role that could act as an owner', () => {
  assertBuiltRefusal(
    'runtime-role',
    preflight(`() => ({ $queryRawUnsafe: async () => [${facts}], $disconnect: async () => {} })`),
  );
});

test('runtime-role-unverified: the preflight cannot ask the database', () => {
  assertBuiltRefusal(
    'runtime-role-unverified',
    preflight(`() => { throw new Error('${SENTINELS[0]}'); }`),
  );
});

test('session-time-zone: the service client refuses a session outside UTC', () => {
  assertBuiltRefusal(
    'session-time-zone',
    `const { createSafePrismaClient } = require('./packages/nest-common/dist/index.js');
    const raw = {
      $extends() { return raw; },
      $queryRawUnsafe() {},
      async $transaction() {
        throw Object.assign(new Error('session TimeZone is not UTC: ${SENTINELS[0]}'), { code: 'P2010' });
      },
    };
    await createSafePrismaClient(() => raw, 'DATABASE_URL_DOCUMENT').$transaction(async () => {});`,
  );
});

test('prisma-client-missing: B2 port for a service with no client', async () => {
  await assertRefusal('prisma-client-missing', () => prismaPort(SENTINELS[0], 'unused'));
});

// --- B2 backfill guards ------------------------------------------------------

/**
 * What Prisma 6 throws when the B1 assertion's own `RAISE EXCEPTION` fires
 * from `$queryRawUnsafe`: `P2010`, with the server's SQLSTATE and message in
 * `meta` (the same shape services/asset-service negative-amount.spec.ts uses).
 */
function b1AssertionError(meta = {}) {
  return Object.assign(new Error(`Raw query failed. Code: \`P0001\`. ${SENTINELS[0]}`), {
    code: 'P2010',
    meta: { code: 'P0001', message: `ERROR: B1: outbox_message.stream_seq is missing`, ...meta },
  });
}

function port({ b1, plan = {}, batch = {}, verify = {} } = {}) {
  const batches = [
    { selected: 2, updated: 2, streams: 1, violations: 0, history_purged: 0, ...batch },
    { selected: 0, updated: 0, streams: 0, violations: 0, history_purged: 0 },
  ];
  const answer = async (sql) => {
    if (sql === b1PreconditionSql()) {
      if (b1 === true) throw b1AssertionError();
      if (b1) throw b1.throws;
      return [];
    }
    if (sql === planSql()) return [{ pending_unsequenced: 2, streams_history_purged: 0, ...plan }];
    if (sql === assignBatchSql()) return [batches.shift()];
    if (sql === counterUpsertSql()) return [{ written: 1 }];
    if (sql === headMaintenanceSql()) return [{ changed: 1 }];
    if (sql === verifySql()) {
      return [
        {
          remaining: 0,
          counter_next_mismatch: 0,
          counter_published_mismatch: 0,
          head_mismatch: 0,
          ...verify,
        },
      ];
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  return {
    query: answer,
    execute: async () => 0,
    transaction: async (fn) => fn({ query: answer }),
  };
}
const backfill = (db) =>
  runServiceBackfill({
    service: 'document',
    db,
    options: parseOptions(['--service', 'document', '--apply'], {}),
    emit: () => undefined,
  });

for (const [code, scripted] of [
  ['b1-precondition', { b1: true }],
  ['history-purged', { plan: { streams_history_purged: 1 } }],
  ['history-purged', { batch: { updated: 0, history_purged: 1 } }],
  ['ordering-violation', { batch: { updated: 0, violations: 1 } }],
  ['no-progress', { batch: { updated: 0 } }],
  ['verification-mismatch', { verify: { head_mismatch: 1 } }],
]) {
  test(`${code}: B2 backfill guard ${JSON.stringify(scripted)}`, async () => {
    await assertRefusal(code, () => backfill(port(scripted)));
  });
}

// #673 r1 F1: a failure to inspect the schema is not a schema refusal. Each of
// these propagates unchanged and reports exactly as it would on its own.
for (const [label, foreign] of [
  ['an unknown error', () => new Error(SENTINELS[0])],
  ['ECONNRESET', () => Object.assign(new Error(SENTINELS[0]), { code: 'ECONNRESET' })],
  ['P1001 (server unreachable)', () => Object.assign(new Error(SENTINELS[0]), { code: 'P1001' })],
  ['P0001 without the B1 prefix', () => b1AssertionError({ message: `ERROR: ${SENTINELS[0]}` })],
  ['the B1 prefix with another SQLSTATE', () => b1AssertionError({ code: '57P01' })],
  ['the B1 text with no SQLSTATE', () => new Error('B1: outbox_message.stream_seq is missing')],
  ['a non-object rejection', () => 'B1: outbox_message.stream_seq is missing'],
]) {
  test(`b1 check failing with ${label} is not reported as b1-precondition`, async () => {
    const error = foreign();
    let thrown;
    try {
      await backfill(port({ b1: { throws: error } }));
    } catch (caught) {
      thrown = caught;
    }
    assert.equal(thrown, error);
    assert.equal(commandFailure(thrown), commandFailure(error));
    assert.match(commandFailure(thrown), /^command failed \(code /);
  });
}

// --- B2 vacuum guards --------------------------------------------------------

const vacuumDb = (rows) => ({
  query: async (sql) => {
    assert.equal(sql, vacuumFactsSql());
    return rows();
  },
  execute: async () => 0,
});
const row = (overrides = {}) => ({
  role: 'rasta_document_migrator',
  qualified: 'outbox_message',
  may_vacuum: true,
  vacuum_count: 1,
  analyze_count: 1,
  ...overrides,
});

test('no-outbox-table: vacuum on a search_path with no outbox table', async () => {
  await assertRefusal('no-outbox-table', () =>
    vacuumService({ service: 'document', db: vacuumDb(() => []), settleMs: 0 }),
  );
});

test('not-table-owner: vacuum as a role that does not own the table', async () => {
  await assertRefusal('not-table-owner', () =>
    vacuumService({
      service: 'document',
      db: vacuumDb(() => [row({ may_vacuum: false })]),
      settleMs: 0,
    }),
  );
});

test('vacuum-unproven: the counters never move', async () => {
  await assertRefusal('vacuum-unproven', () =>
    vacuumService({ service: 'document', db: vacuumDb(() => [row()]), settleMs: 0 }),
  );
});

// --- fleet drain check -------------------------------------------------------

test('lag-unreadable: an expected topic the principal cannot see', () => {
  assertBuiltRefusal(
    'lag-unreadable',
    `await require('./services/fleet-service/dist/fleet/drain-check.command.js')
      .checkConsumerGroupDrained({ listTopics: async () => [] }, 'probe-group', ['probe.topic']);`,
  );
});

// --- marketplace hold-deadline backfill (FU-234) ------------------------------

test('economic-rule-unproven: the database clock is not the margin past the rule instant', () => {
  const since = new Date(Date.now() - 60_000).toISOString();
  assertBuiltRefusal(
    'economic-rule-unproven',
    `const { backfillLegacyHoldDeadlines } = require('./services/marketplace-service/dist/ops/hold-deadline-backfill.js');
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async (sql) => (sql.join('').includes('now() AS now') ? [{ now: new Date() }] : [{ n: 0n }]),
    };
    await backfillLegacyHoldDeadlines({ $transaction: (work) => work(tx) }, {
      apply: false, economicRuleSince: '${since}', operator: 'probe', ticket: 'probe',
      batchSize: 1, maxBatches: 1,
    });`,
  );
});

// --- every operational CLI reports through the closed boundary ---------------

test('every *.cli.ts of a service is driven above, so each reports through commandFailure', () => {
  const driven = new Set(
    [
      ...readFileSync(new URL(import.meta.url), 'utf8').matchAll(
        /'services\/([\w-]+)\/dist\/([\w/.-]+)\.cli\.js'/g,
      ),
    ].map(([, service, path]) => `services/${service}/src/${path}.cli.ts`),
  );
  const clis = authoredFiles(join(root, 'services'))
    .map((file) => relative(root, file))
    .filter((file) => /^services\/[\w-]+\/src\/.+\.cli\.ts$/.test(file));
  assert.ok(clis.length >= 8, clis.join(','));
  for (const file of clis) {
    assert.ok(driven.has(file), `${file}: no refusal test drives it through commandFailure`);
    assert.match(readFileSync(join(root, file), 'utf8'), /\bcommandFailure\(/, file);
  }
});

// --- fail closed -------------------------------------------------------------

test('an unexpected error still prints the generic line and nothing beyond it', () => {
  const pretenders = [
    new Error(SENTINELS.join(' ')),
    Object.assign(new Error(SENTINELS[0]), { code: 'usage', refusalCode: 'usage', name: 'usage' }),
    new B2RefusalError(SENTINELS[0]), // a refusal raised without a code
    new B2RefusalError(SENTINELS[0], SENTINELS[1]), // or with an unregistered one
    markRefusal(new Error(SENTINELS[0]), SENTINELS[1]),
    new Proxy(new Error(SENTINELS[0]), {
      get() {
        throw new Error(SENTINELS[1]);
      },
    }),
    `refused (code usage) ${SENTINELS[0]}`,
    undefined,
  ];
  for (const error of pretenders) {
    assert.equal(commandFailure(error), GENERIC);
  }
  // A registered client code is still the only foreign word that may pass.
  assert.equal(
    commandFailure({ code: 'ECONNREFUSED', message: SENTINELS[0] }),
    `command failed (code ECONNREFUSED); ${TAIL}`,
  );
});

test('every registered refusal code is exercised above, and no other', () => {
  assert.deepEqual([...covered].sort(), [...REFUSAL_CODES].sort());
});
