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
import { dirname, resolve } from 'node:path';
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
function cli(script, args, env, timeout = 120_000) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout,
  });
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

test('runtime-preflight prints an error it did not write only without the run credentials', () => {
  // Past the URL checks, into Kafka: a broker named like the owner password
  // makes kafkajs's own error carry it. The handler prints that error — with
  // the password replaced — and nothing of either sentinel.
  const broker = `${PASSWORD.toLowerCase()}.invalid`;
  const run = cli(
    PREFLIGHT,
    ['refused', 'audit-service'],
    cleanEnv({
      NODE_ENV: 'test',
      KAFKA_ALLOW_PLAINTEXT: 'true',
      KAFKA_BROKERS: `${broker}:1`,
      PREFLIGHT_OWNER_URL: `postgresql://rasta_audit_migrator:${broker}@127.0.0.1:1/db`,
      DATABASE_URL_AUDIT: `postgresql://${USER}:${PASSWORD}@127.0.0.1:1/audit`,
    }),
  );
  assertRefusedWith(run, 'ENOTFOUND <credential>', PREFLIGHT);
});
