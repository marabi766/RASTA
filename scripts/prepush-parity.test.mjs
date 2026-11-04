import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify, parse } from 'yaml';
import { controlledEnv, executeCheck, runParity, validateParity } from './prepush-parity-lib.mjs';

const root = new URL('../', import.meta.url).pathname;
const workflow = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');
const manifest = JSON.parse(readFileSync(`${root}scripts/prepush-parity.json`, 'utf8'));
const scripts = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).scripts;
const sha = 'a'.repeat(40);
const scope = {
  resolvedBase: sha,
  mergeBase: sha,
  paths: ['apps/web/src/a.ts'],
  packages: ['@rasta/web'],
};
const clone = (x) => structuredClone(x);

test('real quality job has complete, explicit coverage and CI executes this guard', () => {
  assert.deepEqual(
    validateParity(workflow, manifest, scripts).map((c) => c.script),
    ['test:prepush-scope', 'test:prepush-parity'],
  );
});

test('fake-step mutant, including alternate pnpm spelling and non-pnpm command, refuses', () => {
  for (const run of ['pnpm run fake:check', 'pnpm fake:check', 'node scripts/new-check.mjs']) {
    const mutant = parse(workflow);
    mutant.jobs.quality.steps.push({ name: 'Fake step', run });
    assert.throws(() => validateParity(stringify(mutant), manifest, scripts));
  }
});

test('missing, malformed, renamed and empty CI jobs refuse', () => {
  for (const text of [
    '[',
    '{}',
    'jobs: {quality: {steps: []}}',
    workflow.replace('  quality:', '  other:'),
  ]) {
    assert.throws(() => validateParity(text, manifest, scripts));
  }
});

test('command, environment, shell, condition and failure handling drift refuses, including exclusions', () => {
  for (const change of [
    { run: 'pnpm run fake:check' },
    { env: { NODE_ENV: 'production' } },
    { shell: 'sh' },
    { if: 'false' },
    { 'continue-on-error': true },
    { 'timeout-minutes': 1 },
  ]) {
    for (const index of [0, 4, 5]) {
      const mutant = parse(workflow);
      Object.assign(mutant.jobs.quality.steps[index], change);
      assert.throws(() => validateParity(stringify(mutant), manifest, scripts));
    }
  }
  const mutant = parse(workflow);
  mutant.jobs.quality.env = { NODE_OPTIONS: '--env-file=.env' };
  assert.throws(() => validateParity(stringify(mutant), manifest, scripts));
});

test('missing reasons, changed root scripts, duplicate entries and missing guard refuse', () => {
  const missingReason = clone(manifest);
  missingReason.steps.find((c) => c.reason).reason = ' ';
  assert.throws(() => validateParity(workflow, missingReason, scripts));
  assert.throws(() =>
    validateParity(workflow, manifest, { ...scripts, 'test:prepush-scope': 'true' }),
  );
  const missing = clone(manifest);
  missing.steps = missing.steps.filter((c) => c.script !== 'test:prepush-parity');
  const mutant = parse(workflow);
  mutant.jobs.quality.steps = missing.steps.map((c) => c.ci);
  assert.throws(() => validateParity(stringify(mutant), missing, scripts));
  const duplicated = clone(manifest);
  duplicated.steps.push(clone(duplicated.steps.find((c) => c.script)));
  mutant.jobs.quality.steps = duplicated.steps.map((c) => c.ci);
  assert.throws(() => validateParity(stringify(mutant), duplicated, scripts));
});

test("executed commands retain main's exact deadline even when script and manifest drift together", () => {
  for (const script of ['test:prepush-scope', 'test:prepush-parity']) {
    for (const deadline of ['', '--test-timeout=0 ', '--test-timeout=600000 ']) {
      const changed = clone(manifest);
      const entry = changed.steps.find((entry) => entry.script === script);
      entry.command = entry.command.replace('--test-timeout=300000 ', deadline);
      assert.throws(() =>
        validateParity(workflow, changed, { ...scripts, [script]: entry.command }),
      );
    }
  }
});

test('runner recomputes selection, executes serially with resolved base and records successes', () => {
  const bases = [],
    executed = [];
  const result = runParity(root, 'some-base', {
    select: (_root, base) => {
      bases.push(base);
      return clone(scope);
    },
    execute: (_root, entry, env) => {
      executed.push({ script: entry.script, command: entry.command, env });
    },
    report: () => {},
  });
  assert.deepEqual(bases, ['some-base', sha]);
  assert.deepEqual(result.receipts, executed);
  assert.equal(executed.length, 2);
  assert.ok(executed.every((entry) => entry.env.SERVICE_ENV_WITHHELD_BASE === sha));
  assert.equal(result.exclusions.length, manifest.steps.length - 2);
});

test('selection error, execution failure and post-execution drift never produce a passing result', () => {
  assert.throws(() =>
    runParity(root, 'bad', {
      select: () => {
        throw Error();
      },
    }),
  );
  let count = 0;
  assert.throws(() =>
    runParity(root, sha, {
      select: () => clone(scope),
      execute: () => {
        count++;
        throw Error();
      },
      report: () => {},
    }),
  );
  assert.equal(count, 1);
  count = 0;
  assert.throws(() =>
    runParity(root, sha, {
      select: () => ({ ...clone(scope), paths: [String(count++)] }),
      execute: () => {},
      report: () => {},
    }),
  );
  count = 0;
  assert.throws(() =>
    runParity(root, sha, {
      select: () => clone(scope),
      execute: () => {
        count++;
      },
      report: () => {},
      read: (dir, file) => {
        const text = readFileSync(`${dir}/${file}`, 'utf8');
        return count && file === 'package.json'
          ? text.replace(scripts['test:prepush-scope'], 'true')
          : text;
      },
    }),
  ); // Root script drift during execution refuses.
});

test('real child ignores root .env and inherited Node options/credentials, and nonzero refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-parity-'));
  const previous = process.env.NODE_OPTIONS;
  try {
    mkdirSync(`${dir}/scripts`);
    writeFileSync(`${dir}/.env`, 'NODE_ENV=production\n');
    process.env.NODE_OPTIONS = '--env-file=.env';
    writeFileSync(
      `${dir}/scripts/prepush-scope.test.mjs`,
      `
      import assert from 'node:assert/strict';
      assert.equal(process.env.NODE_ENV, 'test');
      assert.equal(process.env.NODE_OPTIONS, undefined);
      assert.equal(process.env.SERVICE_ENV_WITHHELD_BASE, '${sha}');
      assert.equal(Object.keys(process.env).some(k => /PASSWORD|TOKEN|SECRET|DATABASE_URL/.test(k)), false);
    `,
    );
    const entry = { command: 'node --test scripts/prepush-scope.test.mjs' };
    executeCheck(dir, entry, controlledEnv(sha));
    writeFileSync(`${dir}/scripts/prepush-scope.test.mjs`, 'process.exit(9);');
    assert.throws(() => executeCheck(dir, entry, controlledEnv(sha)));
    assert.throws(() => controlledEnv('origin/main'));
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
