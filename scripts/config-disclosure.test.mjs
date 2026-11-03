// -----------------------------------------------------------------------------
// Nothing of a configured URL comes back out of the scripts that read one
// (#385 r5, Codex PR-385 r4 F1).
//
//   pnpm test:config-disclosure        (after `pnpm build`: two CLIs load dist)
//
// Each entry point the review named, and each sibling found with them, runs as
// it really runs — the CLI as a process, the library function as called — with
// a database URL whose username and password are the two sentinels of
// refusal-probes.mjs and whose port is not one: `new URL` refuses it, and its
// TypeError carries the whole URL on `.input`. Each must refuse with its fixed
// text (the case reaches the refusal it is about, not an earlier one), and
// neither sentinel may appear anywhere: stdout, stderr, the exit message, or
// the thrown object — message, stack, every own property, its cause chain and
// what `util.inspect` prints.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnreadableUrlError } from '../packages/config/src/url-reader.js';
import { SENTINELS, assertNoSentinel, thrownBy } from './refusal-probes.mjs';
import { MIGRATION_REFUSALS, ledgerRevoke } from './prisma-lib.mjs';
import { urlWithSchema } from './outbox-b2-fixture.mjs';
import {
  UNREADABLE_DATABASE_URL,
  libpqInvocation,
  libpqUrl,
  psqlFileRunner,
  psqlRunner,
} from './verify-migration-reversible-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [USER, PASSWORD] = SENTINELS;
/** Both sentinels as credentials; the port is not a number, so `new URL` refuses it. */
const UNREADABLE = `postgresql://${USER}:${PASSWORD}@127.0.0.1:bad/db`;

/** The environment without any database or OpenTelemetry setting inherited, plus `extra`. */
function cleanEnv(extra) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('DATABASE_URL') && !key.startsWith('PREFLIGHT_'),
    ),
  );
  return { ...env, ...extra };
}

/** Runs `script` with `args` under `env`; its whole output and exit code. */
function cli(script, args, env, timeout = 120_000, nodeArgs = []) {
  const result = spawnSync(
    process.execPath,
    [...nodeArgs, resolve(ROOT, 'scripts', script), ...args],
    {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

/** The CLI refused (non-zero), with `text`, and printed no piece of a sentinel. */
function assertRefusedWith(run, text, label) {
  assert.equal(run.error, undefined, `${label}: did not run (${run.error?.message})`);
  assert.notEqual(run.status, 0, `${label}: exited 0\n${run.output}`);
  assert.ok(run.output.includes(text), `${label}: not refused with its fixed text:\n${run.output}`);
  assertNoSentinel(run.output, label);
}

const IDENTITY_TEXT =
  'DATABASE_URL_IDENTITY_MIGRATOR (else DATABASE_URL_IDENTITY, else DATABASE_URL) cannot be ' +
  'read as a URL; its value is not repeated.';

test('the control: new URL itself prints both sentinels for this URL', () => {
  const error = thrownBy(() => new URL(UNREADABLE));
  assert.throws(() => assertNoSentinel(error), /repeats a sentinel/);
});

test('verify-security-event-outbox-migration.mjs refuses the URL by name only', () => {
  const run = cli(
    'verify-security-event-outbox-migration.mjs',
    [],
    cleanEnv({ DATABASE_URL_IDENTITY_MIGRATOR: UNREADABLE }),
  );
  assertRefusedWith(run, IDENTITY_TEXT, 'verify-security-event-outbox-migration');
});

test('verify-audit-correction-command-migration.mjs refuses the URL by name only', () => {
  const run = cli(
    'verify-audit-correction-command-migration.mjs',
    [],
    cleanEnv({ DATABASE_URL_IDENTITY_MIGRATOR: UNREADABLE }),
  );
  assertRefusedWith(run, IDENTITY_TEXT, 'verify-audit-correction-command-migration');
});

test('verify-outbox-claim-migration.mjs (a sibling) refuses the URL by name only', () => {
  const run = cli(
    'verify-outbox-claim-migration.mjs',
    ['identity'],
    cleanEnv({ DATABASE_URL_IDENTITY_MIGRATOR: UNREADABLE }),
  );
  assertRefusedWith(
    run,
    'identity: DATABASE_URL_IDENTITY_MIGRATOR (else DATABASE_URL_IDENTITY, else DATABASE_URL) ' +
      'cannot be read as a URL',
    'verify-outbox-claim-migration',
  );
});

test('verify-migration-reversible.mjs refuses the selected migrator URL by name only', () => {
  const run = cli(
    'verify-migration-reversible.mjs',
    ['economic'],
    cleanEnv({ DATABASE_URL_ECONOMIC_MIGRATOR: UNREADABLE, DATABASE_URL_ECONOMIC: UNREADABLE }),
  );
  assertRefusedWith(
    run,
    `DATABASE_URL_ECONOMIC_MIGRATOR: ${UNREADABLE_DATABASE_URL}. Refusing to verify.`,
    'verify-migration-reversible',
  );
});

test('verify-seed-guard.mjs --with-database refuses the URL by name, before psql', () => {
  const run = cli(
    'verify-seed-guard.mjs',
    ['--with-database'],
    cleanEnv({ DATABASE_URL_ASSET: UNREADABLE }),
  );
  assertRefusedWith(
    run,
    'asset: DATABASE_URL_ASSET cannot be read as a URL; its value is not repeated',
    'verify-seed-guard',
  );
});

for (const [name, call] of [
  ['libpqUrl', () => libpqUrl(UNREADABLE)],
  ['libpqInvocation', () => libpqInvocation(UNREADABLE)],
  ['psqlRunner', () => psqlRunner(UNREADABLE)],
  ['psqlFileRunner', () => psqlFileRunner(UNREADABLE, 'public')],
]) {
  test(`${name} refuses with a fresh fixed error, before the password is taken out`, () => {
    const error = thrownBy(call);
    assert.ok(error instanceof UnreadableUrlError, `${name}: ${error}`);
    assert.equal(error.message, UNREADABLE_DATABASE_URL);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['message', 'name', 'stack']);
    assertNoSentinel(error, name);
  });
}

test('prisma-lib ledgerRevoke and the B2 fixture refuse with fixed texts', () => {
  const ledger = thrownBy(() =>
    ledgerRevoke({ migratorUrl: UNREADABLE, runtimeUrl: 'postgresql://r:x@h/db' }),
  );
  assert.equal(ledger.message, MIGRATION_REFUSALS.unreadableUrl);
  assertNoSentinel(ledger, 'ledgerRevoke');
  const fixture = thrownBy(() => urlWithSchema(UNREADABLE, 'b2_check'));
  assert.equal(fixture.message, 'the B2 fixture database URL cannot be read as a URL');
  assertNoSentinel(fixture, 'urlWithSchema');
});

const PREFLIGHT = 'runtime-preflight.e2e.mjs';

test('runtime-preflight refuses an unreadable owner URL by name only', () => {
  const run = cli(
    PREFLIGHT,
    ['refused', 'audit-service'],
    cleanEnv({ PREFLIGHT_OWNER_URL: UNREADABLE }),
  );
  assertRefusedWith(
    run,
    'runtime-preflight refused: PREFLIGHT_OWNER_URL cannot be read as a URL; its value is not repeated',
    PREFLIGHT,
  );
});

test("runtime-preflight refuses another role's owner URL without repeating its username", () => {
  // The r4 finding: assert.equal put the username in the AssertionError, and
  // the rejection handler printed its stack.
  const owner = `postgresql://${USER}:${PASSWORD}@127.0.0.1:5432/db`;
  const run = cli(
    PREFLIGHT,
    ['refused', 'audit-service'],
    cleanEnv({ PREFLIGHT_OWNER_URL: owner }),
  );
  assertRefusedWith(
    run,
    "PREFLIGHT_OWNER_URL is not rasta_audit_migrator's URL; its username is not repeated",
    PREFLIGHT,
  );
});

/**
 * Every host lookup fails at once, as DNS does for a name that does not
 * exist, with the error Node's resolver gives (which quotes the host): no
 * network is used.
 */
const NO_DNS = `data:text/javascript,${encodeURIComponent(`
import dns from 'node:dns';
dns.lookup = (host, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  const error = Object.assign(new Error('getaddrinfo ENOTFOUND ' + host), {
    code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host,
  });
  process.nextTick(done, error);
};
`)}`;

test('runtime-preflight reports a failure it did not write by a fixed category, whatever the credentials', () => {
  // Codex PR-385 r5 F1: past the URL checks, into Kafka, with a broker named
  // after the owner password — two characters, which no substring scrubbing
  // could look for — and the username sentinel in the runtime URL. kafkajs's
  // error quotes the broker; the script prints its category and code only.
  const password = 'xy';
  const run = cli(
    PREFLIGHT,
    ['refused', 'audit-service'],
    cleanEnv({
      NODE_ENV: 'test',
      KAFKA_ALLOW_PLAINTEXT: 'true',
      KAFKA_BROKERS: `${password}.invalid:1`,
      PREFLIGHT_OWNER_URL: `postgresql://rasta_audit_migrator:${password}@127.0.0.1:1/db`,
      DATABASE_URL_AUDIT: `postgresql://${USER}:${PASSWORD}@127.0.0.1:1/audit`,
    }),
    120_000,
    ['--import', NO_DNS],
  );
  assertRefusedWith(
    run,
    'runtime-preflight refused: kafka connection failed while reading ' +
      'audit-service.domain-projector as audit-service (KAFKA_BROKERS, KAFKA_SASL_PASSWORD_AUDIT) ' +
      '(code ',
    PREFLIGHT,
  );
  assert.doesNotMatch(run.output, new RegExp(password, 'i'), 'the two-character password');
  assert.doesNotMatch(run.output, /invalid|getaddrinfo|ENOTFOUND [a-z]/i, "kafkajs's own text");
});

/**
 * The command-line contract's echo rule (#385 r6, Codex PR-385 r5 F2 and the
 * PM's addendum): a refusal repeats an argument only once it matched its
 * closed list. Each CLI whose refusal echoed an unknown option, an unknown
 * positional or an invalid value runs here with the sentinels in that place,
 * and refuses during argument parsing — before any connection — by the
 * option's name or the argument's position.
 */
const [SU, SP] = [USER, PASSWORD];
const ECHOES = [
  ['verify-migration-reversible.mjs', [SU], 'No expected-object list for that service'],
  ['verify-migration-reversible.mjs', ['economic', '--schema', SP], '--schema must be a plain'],
  ['verify-outbox-claim-migration.mjs', [SU], 'Unknown service; it is not repeated'],
  ['verify-outbox-claim-migration.mjs', ['--schema', SP], 'Unknown service; it is not repeated'],
  ['verify-security-event-outbox-migration.mjs', ['--schema', SP], '--schema must be a plain'],
  ['verify-audit-correction-command-migration.mjs', ['--schema', SP], '--schema must be a plain'],
  ['progress.mjs', [SU], 'Unknown command; it is not repeated'],
  ['replay-dlq.mjs', [`--${SU}`, SP], 'unknown argument at position 1'],
  ['replay-dlq.mjs', ['--dlq', SU, '--event-id', SP], '--dlq is not a dead-letter topic'],
  ['replay-dlq.mjs', ['--check-marker', 'x', `--${SU}`, SP], 'unknown argument at position 3'],
  ['outbox-b2-backfill.mjs', ['--service', SU, '--apply'], '1 --service value(s), not repeated'],
  ['outbox-b2-backfill.mjs', [`--${SU}`, SP], 'Unknown option at position 1'],
  ['outbox-b2-vacuum.mjs', [`--${SU}`, SP], 'Unknown option at position 1'],
  ['run-test-phases.mjs', [SU], 'unknown task, not repeated'],
  ['verify-test-independence.mjs', [`/tmp/${SU}`, SP], 'no such package directory'],
  [
    'check-local-postgres-config.mjs',
    ['--file', `/tmp/${SU}/${SP}`],
    'cannot read the --file path',
  ],
  ['check-kafka-topic-limits.mjs', [`/tmp/${SU}/${SP}`], 'the topics file cannot be read'],
  ['check-service-boundaries.mjs', ['--root', `/tmp/${SU}/${SP}`], 'nothing scanned under'],
  // The report's directory is checked first (#512 r1 F1); a missing one is refused by a fixed line.
  [
    'backup-restore-drill.mjs',
    ['--report', `/tmp/${SU}/${SP}.json`],
    'the report directory must be private',
  ],
  ['aggregation-evidence.mjs', [`--${SU}`, SP], 'unknown option at position 1'],
  [
    'aggregation-evidence.mjs',
    ['--calibrate', '--pairs', SP, '--slot', '1', 'r.txt'],
    '--pairs must be a positive integer; its value is not repeated',
  ],
];

for (const [script, args, text] of ECHOES) {
  test(`${script} ${args.map((arg) => (/sentinel|JZ97/.test(arg) ? '<sentinel>' : arg)).join(' ')}: refused without echoing it`, () => {
    assertRefusedWith(
      cli(script, args, cleanEnv({}), 60_000),
      script.startsWith('outbox-b2-')
        ? 'command failed (code unknown); diagnostics withheld'
        : text,
      script,
    );
  });
}

for (const [script, args, text] of [
  [
    'replay-dlq.mjs',
    ['--dlq', 'rasta.analytics.v1.dlq', '--event-id', 'EVT-1'],
    'replay-dlq: the Kafka operation failed (KafkaJSNumberOfRetriesExceeded, code ENOTFOUND)',
  ],
  [
    'kafka-acl.mjs',
    ['apply', '--profile', 'development'],
    'kafka acl: the Kafka admin operation failed (KafkaJSNumberOfRetriesExceeded, code ENOTFOUND)',
  ],
]) {
  test(`${script} reports a broker it cannot reach by category and code, whatever the credentials`, () => {
    // As the preflight case above: a two-character password that the broker's
    // name contains, every lookup failing at once, no network. kafkajs's own
    // log and error both quote the broker; neither may be printed.
    const password = 'xy';
    const ca = join(mkdtempSync(join(tmpdir(), 'disclosure-ca-')), 'ca.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n');
    const run = cli(
      script,
      args,
      cleanEnv({
        NODE_ENV: 'test',
        KAFKA_BROKERS: `${password}.invalid:1`,
        KAFKA_SSL: 'true',
        KAFKA_SSL_CA_FILE: ca,
        KAFKA_SASL_PASSWORD_OPS_REPLAY: password,
        KAFKA_SASL_PASSWORD_ADMIN: password,
        DATABASE_URL_AUDIT: `postgresql://${USER}:${PASSWORD}@127.0.0.1:1/audit`,
      }),
      120_000,
      ['--import', NO_DNS],
    );
    assertRefusedWith(run, text, script);
    assert.doesNotMatch(run.output, new RegExp(password, 'i'), 'the two-character password');
    assert.doesNotMatch(run.output, /invalid|getaddrinfo/i, "kafkajs's own text");
  });
}

// #426 F1: retain real generated clients, extensions and CLI orchestration, replacing
// only engine I/O. The first client can pass preflight; the second fails at connect.
const PRISMA_IO_FAILURE = `
const Module = require('node:module');
const originalLoad = Module._load;
let opened = 0;
Module._load = function(id, ...args) {
  const mod = originalLoad.call(this, id, ...args);
  if (!/generated[\\/]prisma$/.test(id) || !mod.PrismaClient) return mod;
  return { ...mod, PrismaClient: class {
    constructor(options) {
      globalThis.disclosureCalls ??= {};
      globalThis.disclosureCalls.construct = (globalThis.disclosureCalls.construct ?? 0) + 1;
      if (process.env.DISCLOSURE_PHASE === 'construct') throw failure();
      const client = new mod.PrismaClient(options);
      const number = ++opened;
      const phase = process.env.DISCLOSURE_PHASE;
      function failure() {
        return Object.assign(new Error('Authentication failed for ${USER} ${PASSWORD}'), {
          name: process.env.DISCLOSURE_PHASE === 'construct' ? 'PrismaClientInitializationError' : 'PrismaClientKnownRequestError',
          code: process.env.DISCLOSURE_CODE, errorCode: process.env.DISCLOSURE_CODE,
          input: '${USER}', cause: new Error('${PASSWORD}'),
        });
      }
      const called = method => { globalThis.disclosureCalls[method] = (globalThis.disclosureCalls[method] ?? 0) + 1; };
      client._engine.start = async () => { called('start'); throw failure(); };
      client._engine.request = async () => { called('request'); throw failure(); };
      client._engine.requestBatch = async () => { called('request'); throw failure(); };
      client._engine.transaction = async () => { called('transaction'); throw failure(); };
      client._engine.stop = async () => { called('stop'); if ((phase === 'disconnect' || phase === 'second-disconnect') && number > (phase === 'second-disconnect' ? 1 : 0)) throw failure(); };
      if (phase.startsWith('second-') && number === 1) {
        client.$queryRawUnsafe = async () => [{
          role: 'rasta_asset', sessionRole: 'rasta_asset', database: 'asset',
          superuser: false, createDb: false, createRole: false, bypassRls: false,
          ownsDatabase: false, ownedSchemas: [], ownsRelationIn: [],
          createOnDatabase: false, createOnSchemas: [], memberOf: [],
        }];
        process.stdout.write('probe: preflight client opened\\n');
      } else if (phase.startsWith('second-')) {
        process.stdout.write('probe: second client opened\\n');
      }
      if (phase === 'second-disconnect' && number === 2) {
        client._engine.start = async () => undefined;
        client.$queryRaw = async () => [{ n: 0 }];
      }
      return client;
    }
  }};
};
`;

function prismaProbe(entry, phase, code = 'P1000', inline = false) {
  const dir = mkdtempSync(join(tmpdir(), 'disclosure-prisma-'));
  const hook = join(dir, 'engine.cjs');
  writeFileSync(hook, PRISMA_IO_FAILURE);
  try {
    const run = spawnSync(
      process.execPath,
      ['--require', hook, ...(inline ? ['-e', entry] : [entry])],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
        env: cleanEnv({
          DISCLOSURE_PHASE: phase,
          DISCLOSURE_CODE: code,
          NODE_ENV: 'test',
          DATABASE_URL_ASSET: 'postgresql://rasta_asset:x@127.0.0.1:1/asset',
          DATABASE_URL_ECONOMIC: 'postgresql://rasta_economic:x@127.0.0.1:1/economic',
          KAFKA_BROKERS: 'localhost:9092',
          KAFKA_ALLOW_PLAINTEXT: 'true',
          OIDC_ISSUER_URL: 'http://localhost:8080',
          OIDC_JWKS_URI: 'http://localhost:8080/keys',
          OIDC_AUDIENCE: 'rasta-api',
          INTERNAL_TOKEN_SECRET: 'x'.repeat(32),
          FLEET_SERVICE_URL: 'http://localhost:3104',
          MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
          DOCUMENT_SERVICE_URL: 'http://localhost:3114',
          CONTRACT_SERVICE_URL: 'http://localhost:3111',
        }),
      },
    );
    assert.equal(run.error, undefined);
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const code of ['P1000', 'P1001', 'PRIVATE_SENTINEL_79']) {
  test(`real asset drain-check CLI: ${code} on SECOND connection is withheld, exit stays 2`, () => {
    const run = prismaProbe(
      'services/asset-service/dist/insurance/drain-check.cli.js',
      'second-connect',
      code,
    );
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /probe: preflight client opened/);
    assert.match(run.output, /probe: second client opened/);
    assert.match(run.output, /command failed \(code /);
    assertNoSentinel(run.output);
  });
}

test('real economic backfill CLI: a LAZY connection failure after preflight stays exit 1', () => {
  const run = prismaProbe(
    'services/economic-service/dist/transaction/resolved-dispute-backfill.cli.js',
    'second-connect',
  );
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /probe: second client opened/);
  assert.match(run.output, /command failed \(code /);
  assertNoSentinel(run.output);
});

test('real asset drain-check CLI: cleanup failure is sanitized and stays exit 2', () => {
  const run = prismaProbe(
    'services/asset-service/dist/insurance/drain-check.cli.js',
    'second-disconnect',
  );
  assert.equal(run.status, 2, run.output);
  assert.match(run.output, /"drained":true/);
  assert.match(run.output, /command failed \(code /);
  assertNoSentinel(run.output);
});

const DATABASE_SERVICES = [
  'analytics',
  'asset',
  'audit',
  'construction',
  'contract',
  'document',
  'economic',
  'fleet',
  'identity',
  'inventory',
  'maintenance',
  'marketplace',
  'notification',
  'organization',
  'procurement',
  'supplier',
];
for (const service of DATABASE_SERVICES) {
  test(`${service} PrismaService: each lifecycle phase verifies its failure and engine call`, () => {
    const run = prismaProbe(
      `
      const { PrismaService } = require('./services/${service}-service/dist/prisma/prisma.service');
      const { DatabaseConnectionError } = require('./packages/nest-common/dist');
      const assert = require('node:assert/strict');
      const { inspect } = require('node:util');
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:path').resolve('services/${service}-service/package.json'));
      const { Logger } = req('@nestjs/common');
      (async () => {
        for (const phase of ['construct', 'connect', 'lazy', 'transaction', 'disconnect']) {
          process.env.DISCLOSURE_PHASE = phase;
          globalThis.disclosureCalls = {};
          const logs = [];
          Logger.prototype.error = (...args) => logs.push(inspect(args));
          let failure;
          try {
            const prisma = new PrismaService('postgresql://rasta_${service}:x@127.0.0.1:1/db');
            if (phase === 'disconnect') {
              if (prisma.stop) {
                const result = await prisma.stop();
                assert.deepEqual(result, { drained: false, unsettled: 0 });
                assert.equal(logs.length, 1);
                assert.ok(logs[0].includes('DatabaseConnectionError: DATABASE_URL_IDENTITY: database connection failed (code P1000); driver diagnostics withheld'));
                failure = logs[0];
              } else if ('${service}' === 'analytics') {
                await prisma.onApplicationShutdown();
              } else {
                await prisma.onModuleDestroy();
              }
            } else if (phase === 'lazy') {
              await prisma.client.$queryRawUnsafe('SELECT 1');
            } else if (phase === 'transaction') {
              await prisma.client.$transaction(async () => undefined);
            } else {
              await prisma.onModuleInit();
            }
          } catch (error) {
            assert.ok(error instanceof DatabaseConnectionError, inspect(error));
            assert.equal(error.setting, 'DATABASE_URL_${service.toUpperCase()}');
            assert.equal(error.code, 'P1000');
            failure = error;
          }
          assert.ok(failure, 'expected failure in ' + phase);
          const method = { construct: 'construct', connect: 'start', lazy: 'request', transaction: 'transaction', disconnect: 'stop' }[phase];
          assert.equal(globalThis.disclosureCalls[method], 1, phase + ': engine invocation');
          process.stdout.write(phase + ': ' + inspect(failure, { depth: 10, showHidden: true }) + '\\n');
        }
        process.exitCode = 2;
      })().catch(error => { console.error(error); process.exitCode = 3; });
    `,
      'all',
      'P1000',
      true,
    );
    assert.equal(run.status, 2, run.output);
    for (const phase of ['construct', 'connect', 'lazy', 'transaction', 'disconnect']) {
      assert.ok(run.output.includes(`${phase}:`), run.output);
    }
    assertNoSentinel(run.output);
  });
}

for (const code of ['P1001', 'P1002', 'P1017', 'P2024', 'P2037']) {
  for (const operation of ['model', 'raw', 'transaction', 'batch']) {
    test(`real Prisma connection acquisition ${code}: ${operation} replaces the whole error`, () => {
      const run = prismaProbe(
        `
        const assert = require('node:assert/strict');
        const { inspect } = require('node:util');
        const { PrismaService } = require('./services/asset-service/dist/prisma/prisma.service');
        const { DatabaseConnectionError, runUnscoped } = require('./packages/nest-common/dist');
        (async () => {
          const prisma = new PrismaService('postgresql://rasta_asset:x@127.0.0.1:1/db');
          const client = prisma.client;
          let failure;
          try {
            await runUnscoped('disclosure probe', () => {
              if ('${operation}' === 'model') return client.asset.findMany();
              if ('${operation}' === 'raw') return client.$queryRawUnsafe('SELECT 1');
              if ('${operation}' === 'batch') return client.$transaction([client.$queryRawUnsafe('SELECT 1')]);
              return client.$transaction(async () => undefined);
            });
          } catch (error) { failure = error; }
          assert.ok(failure instanceof DatabaseConnectionError, inspect(failure));
          assert.equal(failure.code, '${code}');
          assert.equal(failure.cause, undefined);
          assert.equal(globalThis.disclosureCalls['${operation}' === 'transaction' ? 'transaction' : 'request'], 1);
          console.error(inspect(failure, { depth: 10, showHidden: true }));
          process.exitCode = 2;
        })().catch(error => { console.error(error); process.exitCode = 3; });
      `,
        'acquisition',
        code,
        true,
      );
      assert.equal(run.status, 2, run.output);
      assertNoSentinel(run.output);
    });
  }
}

test('real S3 constructor rejects SDK-disclosing endpoint before any SDK diagnostic', () => {
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { S3ObjectStorage } = require('./services/document-service/dist/storage/s3.storage');
    try {
      new S3ObjectStorage({ endpoint: 'data:${USER}:${PASSWORD}', region: 'local',
        accessKeyId: '${USER}', secretAccessKey: '${PASSWORD}', bucket: 'b', forcePathStyle: true });
    } catch (error) { console.error(require('node:util').inspect(error, { showHidden: true, depth: 10 })); process.exitCode = 2; }
  `,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 2, output);
  assert.match(output, /S3_ENDPOINT/);
  assertNoSentinel(output);
});

test('real Redis ready-check diagnostics never print an INFO/NOPERM reply', () => {
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { createRequire } = require('node:module');
    const req = createRequire(require('node:path').resolve('services/api-gateway/package.json'));
    const Redis = req('ioredis').default;
    Redis.prototype.connect = async () => undefined;
    Redis.prototype.info = function(callback) { callback(new Error('NOPERM ${USER} ${PASSWORD}')); return Promise.resolve(); };
    const { RateLimiter } = require('./services/api-gateway/dist/proxy/rate-limiter');
    const limiter = new RateLimiter('redis://localhost:6379', 'rasta');
    limiter.redis._readyCheck((error) => { if (error) process.exitCode = 2; });
  `,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, output);
  assert.match(output, /REDIS_URL: Redis readiness diagnostic, code NOPERM/);
  assertNoSentinel(output);
});

test('real S3 stream: asynchronous cleanup failure cannot become an uncaught SDK diagnostic', () => {
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { Readable } = require('node:stream');
    const { createRequire } = require('node:module');
    const req = createRequire(require('node:path').resolve('services/document-service/package.json'));
    const { S3Client } = req('@aws-sdk/client-s3');
    const body = new Readable({ read() {}, destroy(_error, done) {
      setImmediate(() => done(Object.assign(new Error('${USER} ${PASSWORD}'), {
        cause: new Error('${PASSWORD}'), input: '${USER}',
      })));
    }});
    S3Client.prototype.send = async () => ({ Body: body });
    process.on('uncaughtException', (error) => {
      console.error(require('node:util').inspect(error, { showHidden: true, depth: 10 }));
      process.exitCode = 2;
    });
    const { S3ObjectStorage } = require('./services/document-service/dist/storage/s3.storage');
    (async () => {
      const storage = new S3ObjectStorage({ endpoint: 'http://localhost:9000', region: 'local',
        accessKeyId: 'test', secretAccessKey: 'test', bucket: 'b', forcePathStyle: true });
      const stream = await storage.openReadStream({ objectKey: 'x', maxBytes: 10 });
      stream.on('error', () => undefined);
      stream.destroy();
      await new Promise(resolve => body.once('close', resolve));
      if (!body.destroyed) process.exitCode = 3;
    })();
  `,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, output);
  assertNoSentinel(output);
});

// SDK tracing is configured before module loading, as it is in a deployed process.
function sdkProbe(source, extra = {}) {
  const run = spawnSync(process.execPath, ['-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: cleanEnv({ DEBUG: '', GRPC_TRACE: '', GRPC_VERBOSITY: '', ...extra }),
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, output);
  assertNoSentinel(output);
  return output;
}

const WEB_SOURCE_LOADER = `
  const { createRequire } = require('node:module');
  const req = createRequire(require('node:path').resolve('apps/web/package.json'));
  const { transformSync } = req('@swc/core');
  require.extensions['.ts'] = (mod, filename) => mod._compile(transformSync(
    require('node:fs').readFileSync(filename, 'utf8'),
    { filename, jsc: { parser: { syntax: 'typescript' }, target: 'es2023' }, module: { type: 'commonjs' } }
  ).code, filename);
`;
const REDIS_FACTORY = {
  gateway: `
    const { RateLimiter } = require('./services/api-gateway/dist/proxy/rate-limiter');
    const factory = async () => { const limiter = new RateLimiter(url, 'rasta'); client = limiter.redis; };
  `,
  pending: `
    const { readUnresolved, useUnresolvedStore } = require('./apps/web/src/server/unresolved-request.ts');
    useUnresolvedStore();
    const factory = () => readUnresolved(session, { purpose: 'project-create', target: '' });
  `,
  refresh: `
    const { renewSession, forgetSharedRefreshes } = require('./apps/web/src/server/session-refresh.ts');
    const { sealSession } = require('./apps/web/src/server/session.ts');
    forgetSharedRefreshes();
    const factory = () => renewSession(sealSession(session, process.env.WEB_SESSION_SECRET), {
      env: { WEB_REDIS_URL: url, WEB_SESSION_SECRET: process.env.WEB_SESSION_SECRET,
        WEB_SESSION_MAX_AGE_SECONDS: 3600 },
      refresh: async () => { throw new Error('transport must not run'); },
    });
  `,
};
for (const [name, source] of Object.entries(REDIS_FACTORY)) {
  for (const phase of ['trace', 'ready']) {
    test(`${name} Redis factory contains SDK ${phase} diagnostics before transport`, () => {
      sdkProbe(
        `
        ${WEB_SOURCE_LOADER}
        const assert = require('node:assert/strict');
        const Redis = req('ioredis').default;
        let client;
        let connects = 0;
        Redis.prototype.connect = async function() { client = this; connects++; };
        Redis.prototype.info = function(callback) {
          callback(new Error('NOPERM ${USER} ${PASSWORD}'));
          return Promise.resolve();
        };
        // No operational Redis I/O: exercise each real factory and its real SDK ready-check.
        Redis.prototype.eval = async () => [null, String(Date.now())];
        Redis.prototype.sendCommand = async () => { throw new Error('offline probe'); };
        const { actingAccessToken } = require('./apps/web/src/test/session-token.ts');
        const url = 'redis://${USER}:${PASSWORD}@127.0.0.1:1';
        const session = { subject: 'u', username: 'u', organizationId: 'o', accessToken: actingAccessToken('o'),
          accessTokenExpiresAt: Math.floor(Date.now()/1000) + 1, refreshToken: 'r', csrfToken: 'c',
          issuedAt: Math.floor(Date.now()/1000), loginId: 'l' };
        ${source}
        (async () => {
          if ('${phase}' === 'trace') {
            await assert.rejects(factory, /REDIS_URL: SDK tracing refused/);
            assert.equal(connects, 0);
          } else {
            // Factory callers may refuse the synthetic command response; readiness is still probed.
            await factory().catch(() => undefined);
            assert.equal(connects, 1);
            let checked = 0;
            client._readyCheck(error => { assert.equal(error, null); checked++; });
            assert.equal(checked, 1);
          }
        })().catch(error => { console.error(error); process.exitCode = 3; });
      `,
        {
          DEBUG: phase === 'trace' ? 'ioredis:*' : '',
          WEB_REDIS_URL: `redis://${USER}:${PASSWORD}@127.0.0.1:1`,
          WEB_SESSION_SECRET: 'x'.repeat(32),
          API_GATEWAY_URL: 'http://localhost:3000',
          OIDC_ISSUER_URL: 'http://localhost:8080',
          OIDC_CLIENT_ID: 'rasta-web',
          WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
          NODE_ENV: 'production',
        },
      );
    });
  }
}

test('S3 directory buckets are refused before the SDK can start background session refresh', () => {
  sdkProbe(`
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const req = createRequire(require('node:path').resolve('services/document-service/package.json'));
    const sdk = req('@aws-sdk/client-s3');
    const Original = sdk.S3Client;
    let constructed = 0;
    sdk.S3Client = class extends Original { constructor(options) {
      constructed++;
      super(options);
      // Models the SDK-owned refresh failure, which no public-operation catch can intercept.
      Promise.reject(new Error('${USER} ${PASSWORD}'));
    }};
    const { S3ObjectStorage, ObjectStorageError } = require('./services/document-service/dist/storage/s3.storage');
    assert.throws(() => new S3ObjectStorage({
      endpoint: 'https://${USER}.s3express-use1-az4.us-east-1.amazonaws.com',
      region: 'us-east-1', bucket: 'test--use1-az4--x-s3', forcePathStyle: false,
      accessKeyId: '${USER}', secretAccessKey: '${PASSWORD}',
    }), error => error instanceof ObjectStorageError && error.code === 'UNSUPPORTED_DIRECTORY_BUCKET');
    assert.equal(constructed, 0);
  `);
});

for (const path of ['client', 'worker']) {
  test(`Temporal ${path} refuses grpc tracing before SDK connection`, () => {
    sdkProbe(
      `
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:path').resolve('services/marketplace-service/package.json'));
      const { Runtime, NativeConnection } = req('@temporalio/worker');
      const { Connection } = req('@temporalio/client');
      let connects = 0;
      Runtime.install = () => undefined;
      NativeConnection.connect = Connection.connect = async () => {
        connects++;
        console.error('${USER} ${PASSWORD}');
        throw new Error('unexpected connection');
      };
      const { installTemporalRuntimeLogger } = require('./services/marketplace-service/dist/temporal/runtime-logger');
      const env = { NODE_ENV: 'production', LOG_LEVEL: 'info', SERVICE_VERSION: '1',
        MARKETPLACE_TEMPORAL_ENABLED: true, TEMPORAL_ADDRESS: '${USER}.${PASSWORD}:7233' };
      // The guard must also run after the singleton runtime was installed.
      const trace = process.env.GRPC_TRACE;
      delete process.env.GRPC_TRACE;
      delete process.env.GRPC_VERBOSITY;
      installTemporalRuntimeLogger(env);
      process.env.GRPC_TRACE = trace;
      (async () => {
        if ('${path}' === 'client') {
          const { OrderSagaClient } = require('./services/marketplace-service/dist/temporal/saga.client');
          // Probe transport directly; durable claim delivery is tested with PostgreSQL.
          assert.equal(await new OrderSagaClient(env, {}).deliver('order'), false);
        } else {
          const { OrderSagaWorker } = require('./services/marketplace-service/dist/temporal/worker');
          await new OrderSagaWorker(env, {}, {}).onApplicationBootstrap();
        }
        assert.equal(connects, 0);
        assert.throws(() => installTemporalRuntimeLogger(env), /TEMPORAL_ADDRESS: SDK tracing refused/);
      })().catch(error => { console.error(error); process.exitCode = 3; });
    `,
      { GRPC_TRACE: 'all', GRPC_VERBOSITY: 'DEBUG' },
    );
  });
}

const S3_OPERATIONS = `[
  s => s.createUploadUrl({objectKey:'x', contentType:'application/pdf', contentLength:1, expiresInSeconds:60}),
  s => s.createDownloadUrl({objectKey:'x', contentType:'application/pdf', downloadFilename:'x', expiresInSeconds:60}),
  s => s.copyToSealedKey({sourceKey:'x', destinationKey:'y', ifMatchETag:'etag'}),
  s => s.head('x'), s => s.readPrefix('x', 10),
  s => s.openReadStream({objectKey:'x', maxBytes:10}), s => s.remove('x'), s => s.isHealthy()
]`;

for (const suffix of ['--x-s3', '--xa-s3']) {
  test(`S3 ${suffix}: all eight operations refuse unsupported names with real SDK`, () => {
    sdkProbe(`
      const assert = require('node:assert/strict');
      const { S3ObjectStorage, ObjectStorageError } = require('./services/document-service/dist/storage/s3.storage');
      const operations = ${S3_OPERATIONS};
      (async () => {
        for (const operation of operations) {
          await assert.rejects(async () => operation(new S3ObjectStorage({
            endpoint:'https://s3.us-east-1.amazonaws.com', region:'us-east-1',
            bucket:'${USER}--use1-az4${suffix}', forcePathStyle:false,
            accessKeyId:'${USER}', secretAccessKey:'${PASSWORD}'
          })), error => error instanceof ObjectStorageError && error.code === 'UNSUPPORTED_DIRECTORY_BUCKET');
        }
      })().catch(error => { console.error(error); process.exitCode = 3; });
    `);
  });

  test(`S3 ${suffix}: session auth disabled across all eight real SDK operations`, () => {
    sdkProbe(`
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:path').resolve('services/document-service/package.json'));
      const { S3ObjectStorage } = require('./services/document-service/dist/storage/s3.storage');
      const operations = ${S3_OPERATIONS};
      (async () => {
        const { S3Client, HeadObjectCommand } = req('@aws-sdk/client-s3');
        let controlIdentities = 0;
        const control = new S3Client({region:'us-east-1', endpoint:'https://s3.us-east-1.amazonaws.com',
          credentials:{accessKeyId:'${USER}',secretAccessKey:'${PASSWORD}'},
          s3ExpressIdentityProvider:{getS3ExpressIdentity:async () => {
            controlIdentities++; throw new Error('${USER} ${PASSWORD}');
          }}});
        try {
          await assert.rejects(control.send(new HeadObjectCommand({Bucket:'example--use1-az4${suffix}',Key:'x'})));
          assert.equal(controlIdentities, 1, 'control must request real Express credentials');
        } finally { control.destroy(); }
        let requests = 0, identities = 0;
        for (const operation of operations) {
          const options = { endpoint:'https://s3.us-east-1.amazonaws.com', region:'us-east-1',
            bucket:'ordinary-bucket', forcePathStyle:false, accessKeyId:'${USER}', secretAccessKey:'${PASSWORD}' };
          const storage = new S3ObjectStorage(options);
          assert.equal(storage.client.config.disableS3ExpressSessionAuth, true);
          // Bypass ONLY the name refusal to exercise the independent SDK class boundary.
          options.bucket = 'example--use1-az4${suffix}';
          storage.client.config.s3ExpressIdentityProvider = { getS3ExpressIdentity: async () => {
            identities++;
            throw new Error('${USER} ${PASSWORD}');
          }};
          storage.client.config.maxAttempts = async () => 1;
          storage.client.config.requestHandler = { handle: async request => {
            requests++;
            assert.equal(request.query?.session, undefined);
            throw new Error('${USER} ${PASSWORD}');
          }};
          try { await operation(storage); } catch (error) { console.error(error); }
          storage.client.destroy();
        }
        assert.equal(identities, 0);
        assert.ok(requests >= 5, 'real SDK transport must be reached');
      })().catch(error => { console.error(error); process.exitCode = 3; });
    `);
  });
}

// Exercise actual grpc-js diagnostic sites. Only I/O is synthetic; neither
// Temporal Connection.connect nor NativeConnection.connect is replaced.
for (const owner of ['@temporalio/client', '@temporalio/worker/lib/connection']) {
  for (const category of [
    'trace-alias',
    'excess-pings',
    'proxy-status',
    'proxy-error',
    'proxy-scheme',
    'metadata',
  ]) {
    test(`grpc boundary ${owner}: ${category} with real SDK`, () => {
      const output = sdkProbe(
        `
        const assert = require('node:assert/strict');
        const { createRequire } = require('node:module');
        const { EventEmitter } = require('node:events');
        const req = createRequire(require('node:path').resolve('services/marketplace-service/package.json'));
        const sdkReq = createRequire(req.resolve('${owner}'));
        const clientReq = createRequire(req.resolve('@temporalio/client'));
        const nativeReq = createRequire(req.resolve('@temporalio/worker/lib/connection'));
        assert.equal(clientReq.resolve('@grpc/grpc-js'), nativeReq.resolve('@grpc/grpc-js'));
        assert.equal(req.resolve('@grpc/grpc-js'), clientReq.resolve('@grpc/grpc-js'));
        const grpc = sdkReq('@grpc/grpc-js');
        const grpcReq = createRequire(sdkReq.resolve('@grpc/grpc-js'));
        const logging = grpcReq('./logging');
        let diagnostics = 0;
        const originalLog = logging.log;
        logging.log = (...args) => { diagnostics++; return originalLog(...args); };
        const { installTemporalRuntimeLogger } = require('./services/marketplace-service/dist/temporal/runtime-logger');
        const env = {NODE_ENV:'test', LOG_LEVEL:'trace', SERVICE_VERSION:'1'};
        (async () => {
          installTemporalRuntimeLogger(env);
          // Replacing the logger models a stale/default logger after Runtime installation.
          grpc.setLogger({error: (...args) => console.error(...args)});
          installTemporalRuntimeLogger(env);
          if ('${category}' === 'trace-alias') {
            assert.ok(logging.isTracerEnabled('channel'));
            const { Connection } = req('@temporalio/client');
            const connection = Connection.lazy({address:'${USER}.${PASSWORD}:7233'});
            await connection.close();
            // Prove verbosity was reset (trace arguments include the configured target).
            assert.ok(diagnostics > 0);
          } else if ('${category}' === 'metadata') {
            const result = grpc.Metadata.fromHttp2Headers({'${USER}':'${PASSWORD}\\n'});
            assert.equal(result.get('${USER}').length, 0);
          } else if ('${category}' === 'proxy-scheme') {
            process.env.grpc_proxy = '${USER}://host';
            grpcReq('./http_proxy').mapProxyName({scheme:'dns',path:'${PASSWORD}:7233'}, {});
          } else if ('${category}'.startsWith('proxy-')) {
            const http = require('node:http');
            const request = new EventEmitter();
            request.end = () => {
              if ('${category}' === 'proxy-error') request.emit('error', new Error('${USER} ${PASSWORD}'));
              else request.emit('connect', {statusCode:503}, new EventEmitter(), Buffer.alloc(0));
            };
            const original = http.request;
            http.request = () => request;
            try {
              await assert.rejects(grpcReq('./http_proxy').getProxiedConnection(
                {host:'${USER}',port:80}, {'grpc.http_connect_target':'${PASSWORD}:7233'}));
            } finally { http.request = original; }
          } else {
            const { Subchannel } = grpcReq('./subchannel');
            const { ConnectivityState } = grpcReq('./connectivity-state');
            const { Http2SubchannelConnector } = grpcReq('./transport');
            const http2 = require('node:http2');
            const session = new EventEmitter();
            session.socket = new EventEmitter();
            session.close = () => {};
            session.destroy = () => {};
            session.unref = () => {};
            const connector = new Http2SubchannelConnector({scheme:'dns',path:'${USER}:7233'});
            const originalConnect = http2.connect;
            http2.connect = () => session;
            let transport;
            try {
              const pending = connector.createSession({secure:false,socket:session.socket},
                {host:'${PASSWORD}',port:7233}, {'grpc.enable_channelz':0});
              session.emit('remoteSettings', {});
              transport = await pending;
            } finally { http2.connect = originalConnect; }
            const subchannel = new Subchannel({scheme:'dns',path:'${USER}:7233'},
              {host:'${PASSWORD}',port:7233}, {'grpc.keepalive_time_ms':1000,'grpc.enable_channelz':0},
              grpc.credentials.createInsecure(), {connect: async () => transport});
            subchannel.connectivityState = ConnectivityState.CONNECTING;
            subchannel.startConnectingInternal();
            await Promise.resolve();
            assert.equal(subchannel.connectivityState, ConnectivityState.READY);
            session.emit('goaway', require('node:http2').constants.NGHTTP2_ENHANCE_YOUR_CALM,
              0, Buffer.from('too_many_pings'));
            assert.equal(subchannel.keepaliveTime, 2000);
          }
          assert.ok(diagnostics > 0, 'expected SDK diagnostic site was not reached');
        })().catch(error => { console.error(error); process.exitCode = 3; })
          .finally(async () => { await req('@temporalio/worker').Runtime.instance().shutdown(); });
      `,
        {
          GRPC_NODE_TRACE: category === 'trace-alias' ? 'all' : '',
          GRPC_NODE_VERBOSITY: category === 'trace-alias' ? 'DEBUG' : '',
        },
      );
      if (category === 'trace-alias') assert.doesNotMatch(output, /Temporal gRPC diagnostic/);
      else assert.match(output, /Temporal gRPC diagnostic/);
    });
  }
}

for (const path of ['client', 'worker']) {
  test(`Temporal ${path} installs grpc boundary through real connection failure`, () => {
    const output = sdkProbe(
      `
      const assert = require('node:assert/strict');
      const { createRequire } = require('node:module');
      const req = createRequire(require('node:path').resolve('services/marketplace-service/package.json'));
      const grpcReq = createRequire(req.resolve('@temporalio/client'));
      const grpc = grpcReq('@grpc/grpc-js');
      let installed = 0;
      const setLogger = grpc.setLogger;
      grpc.setLogger = logger => { installed++; setLogger(logger); };
      const env = {NODE_ENV:'test',LOG_LEVEL:'info',SERVICE_VERSION:'1',
        MARKETPLACE_TEMPORAL_ENABLED:true, TEMPORAL_ADDRESS:'http://[${USER}.${PASSWORD}]:bad',
        TEMPORAL_NAMESPACE:'rasta',MARKETPLACE_TEMPORAL_TASK_QUEUE:'test'};
      (async () => {
        if ('${path}' === 'client') {
          const { OrderSagaClient } = require('./services/marketplace-service/dist/temporal/saga.client');
          const client = new OrderSagaClient(env, {});
          assert.equal(await client.deliver('test-order'), false);
          await client.onModuleDestroy();
        } else {
          const { OrderSagaWorker } = require('./services/marketplace-service/dist/temporal/worker');
          const worker = new OrderSagaWorker(env, {}, {});
          await worker.onApplicationBootstrap();
          await worker.onModuleDestroy();
        }
        assert.equal(installed, 1);
        grpc.Metadata.fromHttp2Headers({'${USER}':'${PASSWORD}\\n'});
      })().catch(error => { console.error(error); process.exitCode = 3; })
          .finally(async () => { await req('@temporalio/worker').Runtime.instance().shutdown(); });
    `,
      { GRPC_NODE_TRACE: 'all', GRPC_NODE_VERBOSITY: 'DEBUG' },
    );
    assert.match(output, /Temporal gRPC diagnostic/);
  });
}

test('Temporal refuses a missing grpc boundary with a fixed diagnostic', () => {
  sdkProbe(`
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const req = createRequire(require('node:path').resolve('services/marketplace-service/package.json'));
    const grpc = req('@grpc/grpc-js');
    const { installTemporalRuntimeLogger } = require('./services/marketplace-service/dist/temporal/runtime-logger');
    const original = grpc.setLogger;
    grpc.setLogger = () => { throw new Error('${USER} ${PASSWORD}'); };
    try {
      assert.throws(() => installTemporalRuntimeLogger({NODE_ENV:'test',LOG_LEVEL:'info',SERVICE_VERSION:'1'}),
        error => error.message === 'TEMPORAL_ADDRESS: gRPC diagnostic boundary unavailable' && error.cause === undefined);
    } finally { grpc.setLogger = original; }
  `);
});
