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
import { mkdtempSync, writeFileSync } from 'node:fs';
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
