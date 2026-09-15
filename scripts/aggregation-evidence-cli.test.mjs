/**
 * The calibration runner's refusal paths, as the CLI actually runs them.
 *
 * `aggregation-evidence.test.mjs` covers the pure helpers. This file covers the
 * one thing helpers cannot: what the **entry point** does when a prerequisite
 * stops the campaign before it measures anything. The gap it closes was real —
 * the helpers already said `missingEnvironment` means `INCONCLUSIVE`, while the
 * CLI returned 2 without ever writing the report the caller asked for, so the
 * category never reached an artifact.
 *
 * Nothing here needs Docker or PostgreSQL, and nothing here may measure. The
 * child processes are bounded and their environment is built from nothing, so a
 * shell that happens to carry PostgreSQL credentials cannot turn a
 * "missing environment" test into a live campaign.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEvidenceCli } from './aggregation-evidence.mjs';
import { REQUIRED_CAMPAIGN_ENV } from './aggregation-evidence-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'aggregation-evidence.mjs');
const repoRoot = resolve(here, '..');

const temporaryDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aggregation-evidence-cli-test-'));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Everything a real run could leak, planted where a real run would find it: in
 * the environment it reads and in the exception a failing prerequisite throws.
 */
const LEAKS = Object.freeze({
  url: 'postgresql://rasta_identity:hunter2@db.invalid:5432/rasta',
  password: 'hunter2',
  user: 'rasta_identity',
  host: 'db.invalid',
  address: '10.11.12.13',
  port: '65431',
  database: 'rasta_identity_secret',
  launcherPath: 'C:\\Users\\some-operator\\work\\node_modules\\jest\\bin\\jest.js',
  exception: 'ENOENT: no such file or directory',
  row: '1200|300|310|99999 occurrenceCount: 500',
  testId: 'windowed refusal aggregation (real PostgreSQL) > one row per identity per window',
});

/** A complete environment, every value a sentinel: no refusal may echo one. */
const fullEnv = () => ({
  PGHOST: LEAKS.host,
  PGPORT: LEAKS.port,
  PGUSER: LEAKS.user,
  PGPASSWORD: LEAKS.password,
  PGDATABASE: LEAKS.database,
  DATABASE_URL_IDENTITY: LEAKS.url,
});

const assertNoLeak = (text, label) => {
  for (const [name, sentinel] of Object.entries(LEAKS)) {
    assert.ok(!text.includes(sentinel), `${label} leaked ${name}`);
  }
};

/**
 * Only what Node itself needs in order to start. The child inherits nothing
 * else — in particular not one required name, whatever this shell holds.
 */
const PASSTHROUGH = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
];

function scrubbedEnv(extra = {}) {
  const env = {};
  for (const name of PASSTHROUGH) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of REQUIRED_CAMPAIGN_ENV) delete env[name];
  return { ...env, ...extra };
}

/** The real entry point, bounded, with an environment built from nothing. */
const runCli = (args, env) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });

const fixedDeps = (over = {}) => ({
  readCommit: () => Promise.resolve('abc1234'),
  now: () => new Date('2026-09-15T00:00:00.000Z'),
  measureCampaign: () => assert.fail('a refused campaign must measure nothing'),
  ...over,
});

test('CLI: an incomplete environment still answers a valid calibration request', () => {
  const reportPath = join(tempDir(), 'calibration.txt');
  const result = runCli(['--calibrate', '--pairs', '3', reportPath], scrubbedEnv());

  assert.equal(result.status, 2, `expected a non-zero refusal, stderr: ${result.stderr}`);
  assert.ok(existsSync(reportPath), 'a writable target must receive the artifact');
  const text = readFileSync(reportPath, 'utf8');

  // The names, because a reader needs to know what to provide. Never a value —
  // there is none here, and the next test plants some to prove it.
  for (const name of REQUIRED_CAMPAIGN_ENV) {
    assert.match(text, new RegExp(`\\b${name}\\b`), `the artifact must name ${name}`);
  }
  assert.match(text, /campaign preflight: REFUSED before any measurement/);
  assert.match(text, /pairs: 3 requested, 0 attempted/);

  // Nothing ran, so nothing may be presented as a sample that was taken.
  assert.match(text, /control: not run, outcome=INCONCLUSIVE/);
  for (const pair of [1, 2, 3]) {
    assert.match(text, new RegExp(`pair-${pair}: outcome=INCONCLUSIVE`));
  }
  assert.equal((text.match(/ {2}probe: not run/g) ?? []).length, 3);
  assert.equal((text.match(/ {2}stress: not run/g) ?? []).length, 3);
  assert.match(text, /outcomes: VALID=0 INVALID=0 INCONCLUSIVE=3/);
  assert.match(text, /stress: passed=0 failed=0 of 3/);
  assert.match(text, /topology: measured=no/);

  // Every requested pair stays in every denominator, with nothing available.
  for (const label of [
    'probe_tps',
    'probe_min_interval_tps',
    'probe_longest_stall_s',
    'stress_wall_s',
  ]) {
    assert.match(
      text,
      new RegExp(`${label}: n=3 available=0 unavailable=3 min=n/a median=n/a max=n/a`),
      `${label} must keep all three requested pairs`,
    );
  }

  // One campaign-level event, counted once at campaign scope — not multiplied
  // across the three rows, and not folded into the control's or the pairs' total.
  assert.match(
    text,
    /preflight infrastructure totals \(campaign scope, denominator=1 campaign\): [^\n]*\bmissingEnvironment=1\b/,
  );
  assert.match(text, /infrastructure totals across pairs: [^\n]*\bmissingEnvironment=0\b/);
  assert.match(text, /control infrastructure totals: [^\n]*\bmissingEnvironment=0\b/);

  // Still no capability judgement, and no invented figure.
  for (const forbidden of [/VALID_CAPABLE/, /VALID_INCAPABLE/, /threshold=/, /too slow/i]) {
    assert.ok(!forbidden.test(text), `the refusal artifact asserted ${forbidden}`);
  }
  assert.match(text, /No threshold, no margin, no capability judgement\./);
});

test('CLI: the refusal names the missing variables and never a value it could read', () => {
  const reportPath = join(tempDir(), 'partial.txt');
  const result = runCli(
    ['--calibrate', '--pairs', '1', reportPath],
    // Four present with sentinel values, two absent: the refusal must report
    // exactly the two names and echo none of the four values.
    scrubbedEnv({
      PGHOST: LEAKS.host,
      PGUSER: LEAKS.user,
      PGPASSWORD: LEAKS.password,
      DATABASE_URL_IDENTITY: LEAKS.url,
    }),
  );

  assert.equal(result.status, 2, `expected a non-zero refusal, stderr: ${result.stderr}`);
  const text = readFileSync(reportPath, 'utf8');
  assert.match(text, /missing environment: PGPORT, PGDATABASE/);
  assert.ok(
    !/missing environment:[^\n]*PGHOST/.test(text),
    'a variable that is present is not missing',
  );
  assertNoLeak(text, 'the artifact');
  assertNoLeak(result.stdout, 'the CLI output');
  assertNoLeak(result.stderr, 'the CLI error output');
  assert.ok(!text.includes(reportPath), 'the artifact must not name its own target');
});

test('runner: an unresolved jest launcher refuses the same way, and loses its message', async () => {
  const reportPath = join(tempDir(), 'harness.txt');
  const lines = [];
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2', reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      resolveJestBin: () => {
        throw new Error(`${LEAKS.exception}, open '${LEAKS.launcherPath}'`);
      },
      log: (line) => lines.push(line),
    }),
  });

  assert.equal(code, 2, 'a prerequisite refusal stays non-zero');
  const text = readFileSync(reportPath, 'utf8');
  assert.match(text, /campaign preflight: REFUSED before any measurement/);
  assert.match(text, /pair-1: outcome=INCONCLUSIVE/);
  assert.match(text, /pair-2: outcome=INCONCLUSIVE/);
  assert.match(text, /probe_tps: n=2 available=0 unavailable=2/);
  // The launcher failure is a campaign fact, kept distinguishable from the
  // control's, the pairs' and the suites' totals.
  assert.match(
    text,
    /preflight infrastructure totals \(campaign scope, denominator=1 campaign\): [^\n]*\bharnessError=1\b/,
  );
  assert.match(text, /infrastructure totals across pairs: [^\n]*\bharnessError=0\b/);
  assert.match(text, /control infrastructure totals: [^\n]*\bharnessError=0\b/);
  assert.match(text, /missingEnvironment=0/);

  assertNoLeak(text, 'the artifact');
  assertNoLeak(lines.join('\n'), 'the runner output');
  assert.ok(!text.includes(reportPath), 'the artifact must not name its own target');

  // The same inputs render the same bytes: an artifact is a record, not a trace.
  const twin = join(tempDir(), 'harness-twin.txt');
  await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2', twin],
    env: fullEnv(),
    deps: fixedDeps({
      resolveJestBin: () => {
        throw new Error('something else entirely');
      },
      log: () => {},
    }),
  });
  assert.equal(readFileSync(twin, 'utf8'), text);
});

test('CLI: malformed input has no output target, so it refuses and creates nothing', async () => {
  const dir = tempDir();
  const lines = [];
  let wrote = false;
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2'],
    env: fullEnv(),
    deps: fixedDeps({
      writeReport: () => {
        wrote = true;
      },
      log: (line) => lines.push(line),
    }),
  });
  assert.equal(code, 2);
  assert.equal(wrote, false, 'there is no valid target to write to');
  assert.match(lines.join('\n'), /a report path is required/);
  assert.match(lines.join('\n'), /usage:/);

  // And through the real entry point: a rejected argument leaves no file behind.
  const never = join(dir, 'never.txt');
  const result = runCli(['--calibrate', '--pairs', 'zero', never], scrubbedEnv());
  assert.equal(result.status, 2);
  assert.equal(existsSync(never), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('runner: a report that cannot be written stays non-zero and names neither target nor cause', async () => {
  const reportPath = join(tempDir(), 'no-such-directory', 'calibration.txt');
  const lines = [];
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '1', reportPath],
    env: {},
    deps: fixedDeps({ log: (line) => lines.push(line) }),
  });
  const output = lines.join('\n');
  assert.equal(code, 2);
  assert.equal(existsSync(reportPath), false);
  assert.match(output, /could not write the report: ENOENT/);
  assert.ok(!output.includes(reportPath), 'the refusal must not name the target');
  assert.ok(!output.includes('no such file or directory'), 'the OS message must not travel');

  // An exception whose `code` is not a fixed token is not a token: it is text,
  // and text from an exception may carry anything.
  const noisy = [];
  const noisyCode = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '1', join(tempDir(), 'unreachable.txt')],
    env: {},
    deps: fixedDeps({
      writeReport: () => {
        throw Object.assign(new Error(LEAKS.exception), {
          code: `EACCES opening ${LEAKS.launcherPath}`,
        });
      },
      log: (line) => noisy.push(line),
    }),
  });
  assert.equal(noisyCode, 2);
  assert.match(noisy.join('\n'), /could not write the report: error/);
  assertNoLeak(noisy.join('\n'), 'the write-failure output');
});

test('runner: the legacy evidence invocation keeps refusing without an artifact', async () => {
  const reportPath = join(tempDir(), 'evidence.txt');
  const lines = [];
  let wrote = false;
  const code = await runEvidenceCli({
    argv: [reportPath],
    env: {},
    deps: fixedDeps({
      writeReport: () => {
        wrote = true;
      },
      log: (line) => lines.push(line),
    }),
  });
  assert.equal(code, 2, 'the legacy mode keeps its established exit code');
  assert.equal(wrote, false, 'and its established schema, which has no campaign section');
  assert.equal(existsSync(reportPath), false);
  assert.match(lines.join('\n'), /preflight: missingEnvironment=1/);
});
