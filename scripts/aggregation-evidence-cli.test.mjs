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
 * The boundary is wider than the environment: *every* refusal that happens
 * before the first measurement — an unreadable spec, static contract drift, a
 * work directory that cannot be made — owes the caller the same artifact. The
 * tests below drive each of those through the real `prepareCampaign` by
 * injecting the reader, the validator's input or the directory factory, and
 * assert the measuring half is never entered.
 *
 * Nothing here needs Docker or PostgreSQL, and nothing here may measure. The
 * child processes are bounded and their environment is built from nothing, so a
 * shell that happens to carry PostgreSQL credentials cannot turn a
 * "missing environment" test into a live campaign. The real stress spec is read
 * but never written: a mutated copy lives in memory for the length of one test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runEvidenceCli } from './aggregation-evidence.mjs';
import {
  REQUIRED_CAMPAIGN_ENV,
  STRESS,
  calibrationProbeId,
  calibrationStressId,
} from './aggregation-evidence-lib.mjs';

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
  specPath: 'C:\\Users\\some-operator\\work\\services\\identity-service\\test\\stress.int-spec.ts',
  workDirPath: 'C:\\Users\\some-operator\\AppData\\Local\\Temp\\aggregation-evidence-9xQ',
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

// ---------------------------------------------------------------------------
// The rest of the pre-measurement boundary: the spec, the static contract and
// the temporary work directory. Each of these used to return or throw without
// the artifact the caller asked for.

/** The real spec, read once. Never written — a mutated copy lives in memory only. */
const realSpecSource = readFileSync(join(repoRoot, STRESS.packageDir, STRESS.spec), 'utf8');

/**
 * One constant changed inside the named proof's own body — exactly the drift
 * the static contract exists to catch. Built once, and checked here rather than
 * inside the injected reader: a fixture that threw would be caught by the
 * runner's own "spec could not be read" branch and test the wrong thing.
 */
const DRIFTED_SPEC = realSpecSource.replace(
  'const LANES_PER_CLIENT = 2;',
  'const LANES_PER_CLIENT = 3;',
);
assert.notEqual(DRIFTED_SPEC, realSpecSource, 'the drift fixture must actually change the spec');
const driftedSpecSource = () => DRIFTED_SPEC;

/** Everything a refusal artifact must say when nothing was measured. */
function assertRefusedArtifact(text, pairs, label) {
  assert.match(text, /campaign preflight: REFUSED before any measurement/, label);
  assert.match(text, new RegExp(`pairs: ${pairs} requested, 0 attempted`), label);
  assert.match(text, /topology: measured=no/, label);
  assert.match(text, /control: not run, outcome=INCONCLUSIVE/, label);
  for (let pair = 1; pair <= pairs; pair += 1) {
    assert.match(text, new RegExp(`pair-${pair}: outcome=INCONCLUSIVE`), label);
  }
  assert.equal((text.match(/ {2}probe: not run/g) ?? []).length, pairs, label);
  assert.equal((text.match(/ {2}stress: not run/g) ?? []).length, pairs, label);
  assert.match(text, new RegExp(`outcomes: VALID=0 INVALID=0 INCONCLUSIVE=${pairs}`), label);
  assert.match(text, new RegExp(`stress: passed=0 failed=0 of ${pairs}`), label);
  for (const metric of [
    'probe_tps',
    'probe_min_interval_tps',
    'probe_longest_stall_s',
    'stress_wall_s',
  ]) {
    assert.match(
      text,
      new RegExp(
        `${metric}: n=${pairs} available=0 unavailable=${pairs} min=n/a median=n/a max=n/a`,
      ),
      `${label}: ${metric}`,
    );
  }
  // A refusal is never a measured verdict and never a product-test failure.
  assert.ok(!/outcome=INVALID/.test(text), `${label} called a refusal INVALID`);
  for (const forbidden of [/VALID_CAPABLE/, /VALID_INCAPABLE/, /threshold=/, /too slow/i]) {
    assert.ok(!forbidden.test(text), `${label} asserted ${forbidden}`);
  }
}

/** One `harnessError` at campaign scope, and none anywhere else. */
function assertOneCampaignHarnessError(text, label) {
  assert.match(
    text,
    /preflight infrastructure totals \(campaign scope, denominator=1 campaign\): [^\n]*\bharnessError=1\b/,
    label,
  );
  assert.match(text, /infrastructure totals across pairs: [^\n]*\bharnessError=0\b/, label);
  assert.match(text, /control infrastructure totals: [^\n]*\bharnessError=0\b/, label);
  assert.match(text, /\bmissingEnvironment=0\b/, label);
  // No row may carry the campaign's own event.
  assert.ok(!/^ {2}infrastructure: /m.test(text), `${label} copied the campaign event into a pair`);
}

test('runner: static contract drift refuses with the artifact, and never measures', async () => {
  const reportPath = join(tempDir(), 'drift.txt');
  const lines = [];
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '3', reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      readSpec: driftedSpecSource,
      makeWorkDir: () => assert.fail('a refused campaign makes no temporary directory'),
      log: (line) => lines.push(line),
    }),
  });

  // Contract drift keeps the code the contract check has always returned.
  assert.equal(code, 1, 'a contract refusal stays non-zero');
  assert.ok(existsSync(reportPath), 'a writable target must receive the artifact');
  const text = readFileSync(reportPath, 'utf8');
  assertRefusedArtifact(text, 3, 'the contract-drift artifact');
  assertOneCampaignHarnessError(text, 'the contract-drift artifact');
  assert.match(text, /the static campaign contract failed with 1 finding\(s\)/);
  assert.match(text, /stress constant or assertion changed/);

  // The repository's own fixed sentences may travel; nothing else may.
  assertNoLeak(text, 'the contract-drift artifact');
  assertNoLeak(lines.join('\n'), 'the contract-drift output');
  assert.ok(!text.includes(reportPath), 'the artifact must not name its own target');
  assert.ok(!text.includes('independentStore'), 'no spec source may reach the artifact');
  assert.ok(!text.includes(repoRoot), 'no repository path may reach the artifact');
});

test('runner: many contract findings are still one refused campaign, not many events', async () => {
  const reportPath = join(tempDir(), 'many-findings.txt');
  const lines = [];
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2', reportPath],
    env: fullEnv(),
    // Nothing the contract expects is present, so it answers with many findings.
    deps: fixedDeps({ readSpec: () => '', log: (line) => lines.push(line) }),
  });

  assert.equal(code, 1);
  const text = readFileSync(reportPath, 'utf8');
  const findings = Number(text.match(/contract failed with (\d+) finding\(s\)/)?.[1]);
  assert.ok(findings > 1, `the fixture must produce several findings, got ${findings}`);
  // Several broken clauses, one refused campaign.
  assertOneCampaignHarnessError(text, 'the many-findings artifact');
  assertRefusedArtifact(text, 2, 'the many-findings artifact');
  // The quotation is bounded whatever the finding count.
  assert.ok(
    (text.match(/ {2}problem: /g) ?? []).length === 1,
    'one refusal renders one problem line',
  );
  assertNoLeak(text, 'the many-findings artifact');
  assertNoLeak(lines.join('\n'), 'the many-findings output');
});

test('runner: a spec that cannot be read refuses with the artifact and loses its message', async () => {
  const reportPath = join(tempDir(), 'unreadable-spec.txt');
  const lines = [];
  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2', reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      readSpec: () => {
        throw Object.assign(new Error(`${LEAKS.exception}, open '${LEAKS.specPath}'`), {
          code: 'ENOENT',
          path: LEAKS.specPath,
        });
      },
      makeWorkDir: () => assert.fail('a refused campaign makes no temporary directory'),
      log: (line) => lines.push(line),
    }),
  });

  assert.equal(code, 2, 'a missing prerequisite stays non-zero');
  const text = readFileSync(reportPath, 'utf8');
  assertRefusedArtifact(text, 2, 'the unreadable-spec artifact');
  assertOneCampaignHarnessError(text, 'the unreadable-spec artifact');
  assert.match(text, /the aggregation stress spec could not be read/);
  assertNoLeak(text, 'the unreadable-spec artifact');
  assertNoLeak(lines.join('\n'), 'the unreadable-spec output');
});

test('runner: a work directory that cannot be made refuses with the artifact', async () => {
  const reportPath = join(tempDir(), 'no-workdir.txt');
  const lines = [];
  const code = await runEvidenceCli({
    // The real spec, so the static contract genuinely holds and the refusal is
    // the directory alone.
    argv: ['--calibrate', '--pairs', '2', reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      makeWorkDir: () => {
        throw Object.assign(
          new Error(`EACCES: permission denied, mkdtemp '${LEAKS.workDirPath}'`),
          {
            code: 'EACCES',
          },
        );
      },
      log: (line) => lines.push(line),
    }),
  });

  assert.equal(code, 2);
  const text = readFileSync(reportPath, 'utf8');
  assertRefusedArtifact(text, 2, 'the work-directory artifact');
  assertOneCampaignHarnessError(text, 'the work-directory artifact');
  assert.match(text, /the temporary campaign directory could not be created/);
  assertNoLeak(text, 'the work-directory artifact');
  assertNoLeak(lines.join('\n'), 'the work-directory output');
});

test('runner: the same refusal renders byte-identical artifacts', async () => {
  const render = async (name) => {
    const reportPath = join(tempDir(), name);
    await runEvidenceCli({
      argv: ['--calibrate', '--pairs', '4', reportPath],
      env: fullEnv(),
      deps: fixedDeps({ readSpec: driftedSpecSource, makeWorkDir: () => '', log: () => {} }),
    });
    return readFileSync(reportPath, 'utf8');
  };
  assert.equal(await render('twin-a.txt'), await render('twin-b.txt'));
});

test('runner: preparation that holds reaches measurement once, with the validated plan', async () => {
  const reportPath = join(tempDir(), 'never-written.txt');
  const workDirs = [];
  const specReads = [];
  const calls = [];
  let wrote = false;

  const code = await runEvidenceCli({
    argv: ['--calibrate', '--pairs', '2', reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      readSpec: () => {
        specReads.push(1);
        return realSpecSource;
      },
      makeWorkDir: () => {
        const dir = tempDir();
        workDirs.push(dir);
        return dir;
      },
      writeReport: () => {
        wrote = true;
      },
      measureCampaign: (args) => {
        calls.push(args);
        return 0;
      },
      log: () => {},
    }),
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'measurement is entered exactly once');
  assert.equal(specReads.length, 1, 'the spec is read once and the contract checked once');
  assert.equal(wrote, false, 'a campaign that was not refused writes no refusal artifact');
  assert.equal(existsSync(reportPath), false);

  // The plan handed over is the validated one, with its pairs exactly adjacent.
  const plan = calls[0].plan;
  assert.ok(Array.isArray(plan), 'the validated plan is handed to the measuring half');
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      'control',
      calibrationProbeId(1),
      calibrationStressId(1),
      calibrationProbeId(2),
      calibrationStressId(2),
    ],
  );
  assert.equal(calls[0].pairs, 2);
  assert.equal(calls[0].reportPath, reportPath);

  // Nothing temporary outlives the campaign, on the success path too.
  assert.equal(workDirs.length, 1);
  assert.equal(existsSync(workDirs[0]), false, 'the work directory is released');
});

test('runner: the legacy evidence mode keeps its contract exit code and writes no artifact', async () => {
  const reportPath = join(tempDir(), 'legacy-contract.txt');
  const lines = [];
  let wrote = false;
  const code = await runEvidenceCli({
    argv: [reportPath],
    env: fullEnv(),
    deps: fixedDeps({
      readSpec: driftedSpecSource,
      makeWorkDir: () => assert.fail('a refused campaign makes no temporary directory'),
      writeReport: () => {
        wrote = true;
      },
      log: (line) => lines.push(line),
    }),
  });
  assert.equal(code, 1, 'the legacy mode keeps the exit code the contract check always returned');
  assert.equal(wrote, false, 'and its established schema, which has no campaign section');
  assert.equal(existsSync(reportPath), false);
  assert.match(lines.join('\n'), /preflight: harnessError=1/);
  assertNoLeak(lines.join('\n'), 'the legacy contract output');
});
