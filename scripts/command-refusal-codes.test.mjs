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
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const config = () => require('../packages/config/dist/index.js');
const nestCommon = () => require('../packages/nest-common/dist/index.js');

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
]) {
  test(`usage: ${entry} refuses its command line by code, exit ${exit}`, () => {
    assertCliRefusal('usage', entry, [`--${SENTINELS[0]}`, SENTINELS[1]], exit);
  });
}

// --- environment and credentials ---------------------------------------------

test('node-env: B2 interlock refuses production and an unrecognised NODE_ENV', async () => {
  await assertRefusal('node-env', () => assertEnvironment({ NODE_ENV: 'production' }));
  await assertRefusal('node-env', () => assertEnvironment({ NODE_ENV: SENTINELS[0] }));
});

test('owner-credential: the built guard is reported by the source reporter (one registry)', async () => {
  await assertRefusal('owner-credential', () =>
    config().assertNoMigratorCredentials({ [`DATABASE_URL_${KEY_SENTINELS[0]}_MIGRATOR`]: 'x' }),
  );
});

test('configuration: a service environment that does not validate', async () => {
  const { loadAssetEnv } = require('../services/asset-service/dist/config/env.js');
  await assertRefusal('configuration', () => loadAssetEnv({ PORT: SENTINELS[0] }));
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

const facts = {
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
};
const client = (answer) => ({ $queryRawUnsafe: answer, $disconnect: async () => undefined });
const roleOptions = { service: 'probe', runtimeVariable: 'DATABASE_URL_DOCUMENT' };

test('runtime-role: the preflight refuses a role that could act as an owner', async () => {
  await assertRefusal('runtime-role', () =>
    nestCommon().preflightRuntimeRole(() => client(async () => [facts]), roleOptions),
  );
});

test('runtime-role-unverified: the preflight cannot ask the database', async () => {
  await assertRefusal('runtime-role-unverified', () =>
    nestCommon().preflightRuntimeRole(() => {
      throw new Error(SENTINELS[0]);
    }, roleOptions),
  );
});

test('prisma-client-missing: B2 port for a service with no client', async () => {
  await assertRefusal('prisma-client-missing', () => prismaPort(SENTINELS[0], 'unused'));
});

// --- B2 backfill guards ------------------------------------------------------

function port({ b1, plan = {}, batch = {}, verify = {} } = {}) {
  const batches = [
    { selected: 2, updated: 2, streams: 1, violations: 0, history_purged: 0, ...batch },
    { selected: 0, updated: 0, streams: 0, violations: 0, history_purged: 0 },
  ];
  const answer = async (sql) => {
    if (sql === b1PreconditionSql()) {
      if (b1) throw new Error(SENTINELS[0]);
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

test('lag-unreadable: an expected topic the principal cannot see', async () => {
  const {
    checkConsumerGroupDrained,
  } = require('../services/fleet-service/dist/fleet/drain-check.command.js');
  await assertRefusal('lag-unreadable', () =>
    checkConsumerGroupDrained({ listTopics: async () => [] }, 'probe-group', ['probe.topic']),
  );
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
