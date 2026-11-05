import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify, parse } from 'yaml';
import {
  canonicalJson,
  controlledEnv,
  executeCheck,
  PnpmInputRefusal,
  pnpmInputPins,
  runParity,
  QUALITY_JOBS,
  validateParity as validate,
} from './prepush-parity-lib.mjs';

const root = new URL('../', import.meta.url).pathname;
const workflow = readFileSync(`${root}.github/workflows/ci.yml`, 'utf8');
const manifest = JSON.parse(readFileSync(`${root}scripts/prepush-parity.json`, 'utf8'));
const scripts = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).scripts;
const pnpmInputs = Object.fromEntries(
  ['package.json', 'pnpm-workspace.yaml', '.npmrc'].map((file) => [
    file,
    readFileSync(`${root}${file}`, 'utf8'),
  ]),
);
const validateParity = (workflow, manifest, scripts, inputs = pnpmInputs) =>
  validate(workflow, manifest, scripts, inputs);
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
    mutant.jobs['quality-guards'].steps.push({ name: 'Fake step', run });
    assert.throws(() => validateParity(stringify(mutant), manifest, scripts));
  }
});

test('missing, malformed, renamed and empty CI jobs refuse', () => {
  for (const text of [
    '[',
    '{}',
    'jobs: {quality: {steps: []}}',
    workflow.replace('  quality:', '  other:'),
    workflow.replace('  quality-lint:', '  other:'),
  ]) {
    assert.throws(() => validateParity(text, manifest, scripts));
  }
});

test('FU-111: every quality job and step is pinned; an added, moved, dropped or renamed one refuses', () => {
  assert.deepEqual(Object.keys(manifest.jobs), QUALITY_JOBS);
  // A job nobody listed.
  const extra = parse(workflow);
  extra.jobs['quality-extra'] = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] };
  assert.throws(() => validateParity(stringify(extra), manifest, scripts));
  for (const id of QUALITY_JOBS) {
    // A step dropped, one added, one moved to another job, the job emptied or renamed.
    const dropped = parse(workflow);
    dropped.jobs[id].steps.pop();
    assert.throws(() => validateParity(stringify(dropped), manifest, scripts), `drop ${id}`);
    const added = parse(workflow);
    added.jobs[id].steps.push({ name: 'Sneaked', run: 'true' });
    assert.throws(() => validateParity(stringify(added), manifest, scripts), `add ${id}`);
    const renamed = parse(workflow);
    renamed.jobs[`${id}-x`] = renamed.jobs[id];
    delete renamed.jobs[id];
    assert.throws(() => validateParity(stringify(renamed), manifest, scripts), `rename ${id}`);
    const moved = parse(workflow);
    const [step] = moved.jobs[id].steps.splice(-1, 1);
    const other = QUALITY_JOBS.find((x) => x !== id && x !== 'quality');
    moved.jobs[other].steps.push(step);
    assert.throws(() => validateParity(stringify(moved), manifest, scripts), `move ${id}`);
  }
  // An entry that claims the wrong job.
  const wrongJob = clone(manifest);
  wrongJob.steps[0].job = 'quality-lint';
  assert.throws(() => validateParity(workflow, wrongJob, scripts));
  // The aggregate's verdict is pinned too: a verdict that passes everything refuses.
  const lax = parse(workflow);
  lax.jobs.quality.steps[0].run = 'echo ok';
  assert.throws(() => validateParity(stringify(lax), manifest, scripts));
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
      Object.assign(mutant.jobs['quality-guards'].steps[index], change);
      assert.throws(() => validateParity(stringify(mutant), manifest, scripts));
    }
  }
  const mutant = parse(workflow);
  mutant.jobs['quality-guards'].env = { NODE_OPTIONS: '--env-file=.env' };
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
  mutant.jobs['quality-guards'].steps = missing.steps.map((c) => c.ci);
  assert.throws(() => validateParity(stringify(mutant), missing, scripts));
  const duplicated = clone(manifest);
  duplicated.steps.push(clone(duplicated.steps.find((c) => c.script)));
  mutant.jobs['quality-guards'].steps = duplicated.steps.map((c) => c.ci);
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

// Keep each refusal independent so removing one clause cannot hide behind another.
test('workflow context values and unknown keys refuse without a reviewed pin', () => {
  for (const change of [
    { name: 'Other' },
    { on: {} },
    { concurrency: {} },
    { permissions: {} },
    { defaults: { run: { shell: 'true {0}' } } },
    { env: { ...manifest.workflow.env, NODE_OPTIONS: '--require=./injected.cjs' } },
    { env: { ...manifest.workflow.env, NODE_VERSION: '18' } },
    { futureSetting: true },
  ]) {
    assert.throws(() =>
      validateParity(stringify({ ...parse(workflow), ...change }), manifest, scripts),
    );
  }
});

test('all job values and unknown job keys refuse independently', () => {
  for (const change of [
    { name: 'Other' },
    { 'runs-on': 'windows-latest' },
    { 'timeout-minutes': 0.05 },
    { env: { NODE_OPTIONS: '--require=./injected.cjs' } },
    { defaults: {} },
    { container: 'node:18' },
    { services: {} },
    { if: 'false' },
    { 'continue-on-error': true },
    { permissions: {} },
    { strategy: {} },
    { futureSetting: true },
  ]) {
    for (const id of QUALITY_JOBS) {
      const copy = parse(workflow);
      Object.assign(copy.jobs[id], change);
      assert.throws(() => validateParity(stringify(copy), manifest, scripts), id);
    }
  }
});

test('every extra executed-step field refuses even with CI and manifest co-drift', () => {
  for (const change of [
    { shell: 'true {0}' },
    { 'working-directory': 'services/asset-service' },
    { 'timeout-minutes': 0.01 },
    { env: {} },
    { if: 'false' },
    { 'continue-on-error': true },
    { futureSetting: true },
  ]) {
    for (const script of ['test:prepush-scope', 'test:prepush-parity']) {
      const changed = clone(manifest),
        ci = parse(workflow);
      const index = changed.steps.findIndex((entry) => entry.script === script);
      Object.assign(changed.steps[index].ci, change);
      ci.jobs['quality-guards'].steps[index] = changed.steps[index].ci;
      assert.throws(() => validateParity(stringify(ci), changed, scripts));
    }
  }
});

test('manifest version, step array, trailing entry and executed reasons refuse independently', () => {
  for (const mutate of [
    (m) => {
      m.version = 1;
    },
    (m) => {
      m.steps = { ...m.steps, length: m.steps.length };
    },
    (m) => {
      m.steps.push({ ci: { run: 'true' }, reason: 'Extra' });
    },
    (m) => {
      m.steps.find((e) => e.script).reason = '';
    },
    (m) => {
      delete m.steps[0].reason;
    },
    (m) => {
      m.steps[0].reason = 42;
    },
  ]) {
    const changed = clone(manifest);
    mutate(changed);
    assert.throws(() => validateParity(workflow, changed, scripts));
  }
});

test('executed run and exact script-to-command binding refuse co-drift', () => {
  const changed = clone(manifest),
    ci = parse(workflow);
  const index = changed.steps.findIndex((e) => e.script);
  changed.steps[index].ci.run = 'true';
  ci.jobs['quality-guards'].steps[index] = changed.steps[index].ci;
  assert.throws(() => validateParity(stringify(ci), changed, scripts));
  for (const script of ['test:prepush-scope', 'test:prepush-parity']) {
    for (const prefix of ['pre', 'post']) {
      assert.throws(() =>
        validateParity(workflow, manifest, { ...scripts, [`${prefix}${script}`]: 'true' }),
      );
    }
  }
  const swapped = clone(manifest),
    commands = { ...scripts };
  for (const entry of swapped.steps.filter((e) => e.script)) {
    entry.command = entry.command.replace(
      /prepush-(scope|parity)/,
      (_, name) => `prepush-${name === 'scope' ? 'parity' : 'scope'}`,
    );
    commands[entry.script] = entry.command;
  }
  assert.throws(() => validateParity(workflow, swapped, commands));
});

test('every repository pnpm input is pinned, missing inputs and run settings refuse', () => {
  for (const file of Object.keys(pnpmInputs)) {
    for (const value of [undefined, `${pnpmInputs[file]}\n# drift`]) {
      assert.throws(() =>
        validateParity(workflow, manifest, scripts, { ...pnpmInputs, [file]: value }),
      );
    }
  }
  for (const setting of ['scriptShell', 'nodeOptions', 'enablePrePostScripts', 'futureSetting']) {
    assert.throws(() =>
      validateParity(workflow, manifest, scripts, {
        ...pnpmInputs,
        'pnpm-workspace.yaml': `${pnpmInputs['pnpm-workspace.yaml']}\n${setting}: true\n`,
      }),
    );
    assert.throws(() =>
      validateParity(workflow, manifest, scripts, {
        ...pnpmInputs,
        '.npmrc': `${pnpmInputs['.npmrc']}\n${setting}=true\n`,
      }),
    );
  }
  const crlf = Object.fromEntries(
    Object.entries(pnpmInputs).map(([file, text]) => [file, text.replace(/\n/g, '\r\n')]),
  );
  assert.equal(validateParity(workflow, manifest, scripts, crlf).length, 2);
  const cr = Object.fromEntries(
    Object.entries(pnpmInputs).map(([file, text]) => [file, text.replace(/\n/g, '\r')]),
  );
  assert.equal(validateParity(workflow, manifest, scripts, cr).length, 2);
  // Hooks stay forbidden even if the package.json projection is deliberately repinned.
  const pkg = JSON.parse(pnpmInputs['package.json']);
  pkg.scripts['pretest:prepush-scope'] = 'true';
  const inputs = { ...pnpmInputs, 'package.json': JSON.stringify(pkg) },
    changed = clone(manifest);
  changed.pnpmInputs = pnpmInputPins(workflow, inputs);
  assert.throws(() => validateParity(workflow, changed, pkg.scripts, inputs));
});

test('pnpm inputs are re-read after execution and drift refuses', () => {
  for (const target of ['.npmrc', 'pnpm-workspace.yaml']) {
    let ran = false;
    assert.throws(() =>
      runParity(root, sha, {
        select: () => clone(scope),
        execute: () => {
          ran = true;
        },
        report: () => {},
        read: (dir, file) =>
          readFileSync(`${dir}/${file}`, 'utf8') + (ran && file === target ? '\n# drift' : ''),
      }),
    );
    assert.equal(ran, true);
  }
});

// FU-093: package.json is pinned by a projection of what the quality jobs can reach, not by its
// whole-file digest. Each rule below is independent; a repinned manifest is the positive control.
const withPackage = (mutate) => {
  const pkg = JSON.parse(pnpmInputs['package.json']);
  mutate(pkg);
  return { ...pnpmInputs, 'package.json': `${JSON.stringify(pkg, null, 2)}\n` };
};
const scriptsOf = (inputs) => JSON.parse(inputs['package.json']).scripts;
const repinned = (inputs, wf = workflow) => ({
  ...clone(manifest),
  pnpmInputs: pnpmInputPins(wf, inputs),
});
const refusesInput = (fn, pattern) =>
  assert.throws(fn, (error) => error instanceof PnpmInputRefusal && pattern.test(error.message));
const reached = () => Object.keys(manifest.pnpmInputs['package.json'].scripts);
const pinOf = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

test('FU-093: the committed pin is the projection of the current repository', () => {
  assert.deepEqual(manifest.pnpmInputs, pnpmInputPins(workflow, pnpmInputs));
  // Derived from the quality jobs: every root script they run, directly or through another one.
  const direct = new Set();
  for (const id of QUALITY_JOBS)
    for (const step of parse(workflow).jobs[id].steps)
      for (const [, name] of (step.run ?? '').matchAll(/pnpm run ([\w:-]+)/g)) direct.add(name);
  assert.ok(direct.size > 50);
  for (const name of direct) assert.ok(reached().includes(name), name);
  assert.ok(reached().includes('lint:scripts')); // only through `lint`
  for (const unreached of ['verify', 'dev', 'test:migration', 'prepush:parity'])
    assert.ok(!reached().includes(unreached), unreached);
  assert.deepEqual(manifest.pnpmInputs['package.json'].scripts.lint, pinOf(scripts.lint));
});

test('FU-093: an unrelated script added, changed or removed keeps the pin', () => {
  for (const mutate of [
    (pkg) => {
      pkg.scripts['test:brand-new-thing'] = 'node --test scripts/brand-new-thing.test.mjs';
    },
    (pkg) => {
      pkg.scripts.verify = 'true';
    },
    (pkg) => {
      delete pkg.scripts['test:migration'];
    },
    (pkg) => {
      pkg.scripts['preverify'] = 'true'; // a hook of a script no quality job runs
    },
  ]) {
    const inputs = withPackage(mutate);
    assert.equal(validateParity(workflow, manifest, scriptsOf(inputs), inputs).length, 2);
  }
  // Formatting and key order are not part of the projection.
  const pkg = JSON.parse(pnpmInputs['package.json']);
  const reordered = { ...pkg, engines: Object.fromEntries(Object.entries(pkg.engines).reverse()) };
  for (const text of [JSON.stringify(pkg), JSON.stringify(reordered, null, 4)]) {
    const inputs = { ...pnpmInputs, 'package.json': text };
    assert.equal(validateParity(workflow, manifest, pkg.scripts, inputs).length, 2);
  }
});

test('FU-093: a changed body of a script the quality jobs reach refuses until repinned', () => {
  for (const name of ['test:progress', 'lint', 'lint:scripts', 'test:unit:ci', 'db:generate']) {
    const inputs = withPackage((pkg) => {
      pkg.scripts[name] += ' && true';
    });
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      new RegExp(`scripts "${name}"`),
    );
    assert.equal(validateParity(workflow, repinned(inputs), scriptsOf(inputs), inputs).length, 2);
  }
});

test('FU-093: packageManager, engines, a pnpm key and any other top-level key refuse', () => {
  for (const [key, mutate] of [
    ['packageManager', (pkg) => (pkg.packageManager = 'pnpm@9.0.0')],
    ['engines', (pkg) => (pkg.engines.node = '>=18')],
    ['engines', (pkg) => delete pkg.engines],
    ['pnpm', (pkg) => (pkg.pnpm = { overrides: { yaml: '1.0.0' } })],
    ['devEngines', (pkg) => (pkg.devEngines = { packageManager: { name: 'npm' } })],
    ['type', (pkg) => (pkg.type = 'module')],
    ['devDependencies', (pkg) => (pkg.devDependencies.yaml = '*')],
    ['futureSetting', (pkg) => (pkg.futureSetting = true)],
  ]) {
    const inputs = withPackage(mutate);
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      new RegExp(`fields "${key}"`),
    );
  }
});

test('FU-093: a hook or install lifecycle script on the reached set refuses', () => {
  for (const name of [
    'pretest:progress',
    'postlint:scripts',
    'postinstall',
    'prepare',
    'pnpm:devPreinstall',
  ]) {
    const inputs = withPackage((pkg) => {
      pkg.scripts[name] = 'true';
    });
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      new RegExp(`scripts "${name}"`),
    );
  }
});

test('FU-093: a script the quality jobs run that is missing refuses, and cannot be repinned', () => {
  for (const name of ['test:progress', 'build', 'lint:scripts', 'test:prepush-parity']) {
    const inputs = withPackage((pkg) => {
      delete pkg.scripts[name];
    });
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      new RegExp(`runs script "${name}", which is missing`),
    );
    refusesInput(() => pnpmInputPins(workflow, inputs), /which is missing/);
  }
  // A new CI step for a new script: the pin must name the script before the step passes.
  const ci = parse(workflow),
    changed = clone(manifest);
  const step = { name: 'New guard', run: 'pnpm run test:new-guard' };
  ci.jobs['quality-guards'].steps.push(step);
  const at = changed.steps.findLastIndex((entry) => entry.job === 'quality-guards') + 1;
  changed.steps.splice(at, 0, { job: 'quality-guards', ci: step, reason: 'New guard.' });
  const inputs = withPackage((pkg) => {
    pkg.scripts['test:new-guard'] = 'node --test scripts/new-guard.test.mjs';
  });
  refusesInput(
    () => validateParity(stringify(ci), changed, scriptsOf(inputs), inputs),
    /scripts "test:new-guard"/,
  );
  changed.pnpmInputs = pnpmInputPins(stringify(ci), inputs);
  assert.equal(validateParity(stringify(ci), changed, scriptsOf(inputs), inputs).length, 2);
});

test('FU-093: the whole-file pin form refuses, even when it is the current digest', () => {
  for (const digest of [
    createHash('sha256').update(pnpmInputs['package.json']).digest('hex'),
    '40f27c311fff079a2858f524e6a62602e5961ba0466cbf287e1f89d48b4466bb',
  ]) {
    const old = clone(manifest);
    old.pnpmInputs['package.json'] = digest;
    refusesInput(() => validateParity(workflow, old, scripts), /whole-file digest/);
  }
  for (const mutate of [
    (pin) => (pin.projection = 'whole-file'),
    (pin) => delete pin.projection,
    (pin) => (pin.scripts['stale:entry'] = pin.scripts.lint),
    (pin) => delete pin.scripts.build,
    (pin) => (pin.fields = {}),
    (pin) => (pin.extra = {}),
  ]) {
    const changed = clone(manifest);
    mutate(changed.pnpmInputs['package.json']);
    refusesInput(() => validateParity(workflow, changed, scripts), /pnpm inputs refused/);
  }
  const noPins = clone(manifest);
  delete noPins.pnpmInputs;
  refusesInput(() => validateParity(workflow, noPins, scripts), /pnpm inputs refused/);
});

test('FU-093: malformed package.json or a projection that cannot be computed refuses', () => {
  for (const text of ['{', '[]', '{"scripts": []}', '{"scripts": {"lint": 1}}', '﻿{}', 'null']) {
    refusesInput(
      () => validateParity(workflow, manifest, scripts, { ...pnpmInputs, 'package.json': text }),
      /package\.json (is not valid JSON|has no scripts|has a script)/,
    );
  }
  // Package manager invocations whose root scripts cannot be named, in a quality step or in a
  // reached script, refuse even when the manifest is co-updated: the projection cannot be computed.
  for (const run of [
    'pnpm lint',
    'pnpm run "lint"',
    'pnpm run test:$NAME',
    'pnpm -w run lint',
    'pnpm --filter rasta lint',
    'pnpm --filter ./ lint',
    'pnpm --filter @rasta/contracts -w lint',
    'pnpm --filter @rasta/contracts -r lint',
    'pnpm run -w',
    'pnpm --dir services/audit-service run test:retry-replay',
    'pnpm install',
    'npm run lint',
    'npx turbo run lint',
    'yarn lint',
    'corepack pnpm run lint',
    'node_modules/.bin/pnpm run lint',
    'pnpm run lint pnpm',
  ]) {
    const ci = parse(workflow),
      changed = clone(manifest);
    const index = changed.steps.findIndex((entry) => entry.ci.run === 'pnpm run lint');
    const job = changed.steps[index].job;
    const position = ci.jobs[job].steps.findIndex((step) => step.run === 'pnpm run lint');
    ci.jobs[job].steps[position].run = run;
    changed.steps[index].ci.run = run;
    refusesInput(() => validateParity(stringify(ci), changed, scripts), /cannot be named/);
    const inputs = withPackage((pkg) => {
      pkg.scripts['lint:scripts'] = `${run} && ${pkg.scripts['lint:scripts']}`;
    });
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      /script "lint:scripts" runs a package manager command/,
    );
  }
});

test('FU-093: indirection that could run the package manager unseen refuses', () => {
  for (const run of [
    '$PM run lint',
    '"$(command -v pnpm)" run lint',
    'eval "$CMD"',
    'bash -c x',
    'X=1 sh -c x',
    'xargs -n1 true',
  ]) {
    const ci = parse(workflow),
      changed = clone(manifest);
    const index = changed.steps.findIndex((entry) => entry.ci.run === 'pnpm run lint');
    const job = changed.steps[index].job;
    const position = ci.jobs[job].steps.findIndex((step) => step.run === 'pnpm run lint');
    ci.jobs[job].steps[position].run = run;
    changed.steps[index].ci.run = run;
    refusesInput(
      () => validateParity(stringify(ci), changed, scripts),
      /expansion or a shell string/,
    );
    const inputs = withPackage((pkg) => {
      pkg.scripts['lint:scripts'] = `${pkg.scripts['lint:scripts']} && ${run}`;
    });
    refusesInput(
      () => validateParity(workflow, manifest, scriptsOf(inputs), inputs),
      /script "lint:scripts" runs a command through/,
    );
  }
  // An assignment prefix whose value is an expansion is not a command word.
  const ci = parse(workflow);
  const runs = QUALITY_JOBS.flatMap((id) => ci.jobs[id].steps.map((step) => step.run ?? ''));
  assert.ok(runs.some((run) => run.includes('SERVICE_ENV_WITHHELD_BASE="$base" pnpm run')));
});

test('FU-093: install lifecycle scripts are projected even with no install step in the jobs', () => {
  const ci = parse(workflow);
  for (const id of QUALITY_JOBS)
    ci.jobs[id].steps = ci.jobs[id].steps.filter((step) => !/pnpm install/.test(step.run ?? ''));
  const before = pnpmInputPins(stringify(ci), pnpmInputs);
  for (const name of ['postinstall', 'prepare']) {
    const inputs = withPackage((pkg) => {
      pkg.scripts[name] = 'true';
    });
    assert.notDeepEqual(pnpmInputPins(stringify(ci), inputs), before, name);
  }
});

test("FU-093: a --filter naming the root package is not another workspace's script", () => {
  for (const [name, filter] of [
    ['@rasta/root', '@rasta/root'],
    ['rasta', 'rasta'],
  ]) {
    const inputs = withPackage((pkg) => {
      pkg.name = name;
      pkg.scripts['lint:scripts'] =
        `pnpm --filter ${filter} lint && ${pkg.scripts['lint:scripts']}`;
    });
    refusesInput(() => pnpmInputPins(workflow, inputs), /cannot be named/);
  }
  const other = withPackage((pkg) => {
    pkg.scripts['lint:scripts'] =
      `pnpm --filter @rasta/contracts build && ${pkg.scripts['lint:scripts']}`;
  });
  assert.ok(pnpmInputPins(workflow, other));
});
