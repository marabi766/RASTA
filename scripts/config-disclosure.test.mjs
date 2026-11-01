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
    assertRefusedWith(cli(script, args, cleanEnv({}), 60_000), text, script);
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
      if (process.env.DISCLOSURE_PHASE === 'construct') throw failure();
      const client = new mod.PrismaClient(options);
      const number = ++opened;
      const phase = process.env.DISCLOSURE_PHASE;
      function failure() {
        return Object.assign(new Error('Authentication failed for ${USER} ${PASSWORD}'), {
          name: 'PrismaClientInitializationError', errorCode: process.env.DISCLOSURE_CODE,
          input: '${USER}', cause: new Error('${PASSWORD}'),
        });
      }
      client._engine.start = async () => { throw failure(); };
      client._engine.request = async () => { throw failure(); };
      client._engine.transaction = async () => { throw failure(); };
      client._engine.stop = async () => { if ((phase === 'disconnect' || phase === 'second-disconnect') && number > (phase === 'second-disconnect' ? 1 : 0)) throw failure(); };
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
    assert.match(run.output, /DATABASE_URL_ASSET: database connection failed/);
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
  assert.match(run.output, /DATABASE_URL_ECONOMIC: database connection failed/);
  assertNoSentinel(run.output);
});

test('real asset drain-check CLI: cleanup failure is sanitized and stays exit 2', () => {
  const run = prismaProbe(
    'services/asset-service/dist/insurance/drain-check.cli.js',
    'second-disconnect',
  );
  assert.equal(run.status, 2, run.output);
  assert.match(run.output, /"drained":true/);
  assert.match(run.output, /DATABASE_URL_ASSET: database connection failed/);
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
  test(`${service} PrismaService: construction, connect, lazy, transaction and disconnect diagnostics`, () => {
    const run = prismaProbe(
      `
      const { PrismaService } = require('./services/${service}-service/dist/prisma/prisma.service');
      const { inspect } = require('node:util');
      (async () => {
        for (const phase of ['construct', 'connect', 'lazy', 'transaction', 'disconnect']) {
          process.env.DISCLOSURE_PHASE = phase;
          try {
            const prisma = new PrismaService('postgresql://rasta_${service}:x@127.0.0.1:1/db');
            if (phase === 'disconnect') {
              if (prisma.stop) {
                const result = await prisma.stop();
                if (result.drained) { process.exitCode = 3; return; }
                process.stdout.write('disconnect: DATABASE_URL_IDENTITY failed closed\\n');
                continue;
              }
              await prisma.onModuleDestroy();
            } else if (phase === 'lazy') {
              await prisma.client.$queryRawUnsafe('SELECT 1');
            } else if (phase === 'transaction') {
              await prisma.client.$transaction(async () => undefined);
            } else {
              await prisma.onModuleInit();
            }
            process.stdout.write('unexpected success: ' + phase);
            process.exitCode = 3;
            return;
          } catch (error) {
            process.stdout.write(phase + ': ' + inspect(error, { depth: 10, showHidden: true }) + '\\n');
          }
        }
        process.exitCode = 2;
      })();
    `,
      'all',
      'P1000',
      true,
    );
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, new RegExp(`DATABASE_URL_${service.toUpperCase()}`));
    for (const phase of ['construct', 'connect', 'lazy', 'transaction', 'disconnect']) {
      assert.ok(run.output.includes(`${phase}:`), run.output);
    }
    assertNoSentinel(run.output);
  });
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
