import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTestPhaseInputs } from './check-test-phases.mjs';
import {
  CALIBRATION_SCRIPT,
  EXCLUSIVE_PHASE,
  planTestRun,
  projectFiles,
  scriptCommands,
  selectedProjects,
  shellWords,
  stressProofTitles,
  stripJsonComments,
  validateInfraFreeTestTask,
  validateTestPhases,
  workflowStepCommands,
} from './test-phases-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, 'check-test-phases.mjs');
const SPEC = EXCLUSIVE_PHASE.spec;

/** The real repository inputs, deep-copied so a mutation never leaks between tests. */
const real = () => structuredClone(readTestPhaseInputs());

function expectProblem(inputs, pattern) {
  const problems = validateTestPhases(inputs);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `no problem matched ${pattern}; got:\n${problems.join('\n') || '(none)'}`,
  );
}

const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `fixture text not found: ${from}`);
  return text.replace(from, to);
};

// ---------------------------------------------------------------------------
// The orchestrator's plan
// ---------------------------------------------------------------------------

test('plan: only test:integration reaches the stress task, and it goes last', () => {
  // `test` stops after the workspace phase. The stress spec needs a real
  // PostgreSQL, and `pnpm verify` runs `pnpm test`.
  assert.deepEqual(planTestRun(['test']), [{ phase: 'workspace', args: ['run', 'test'] }]);

  assert.deepEqual(planTestRun(['test:integration']), [
    { phase: 'workspace', args: ['run', 'test:integration'] },
    {
      phase: 'exclusive',
      args: ['run', 'test:aggregation-stress', '--filter=@rasta/identity-service'],
    },
  ]);
});

test('plan: arguments after `--` reach both phases unchanged, quotes and spaces included', () => {
  const pattern = '--testNamePattern=(tenant|subtree visibility)';
  const [workspace, exclusive] = planTestRun(['test:integration', '--', pattern]);
  assert.deepEqual(workspace.args, ['run', 'test:integration', '--', pattern]);
  assert.deepEqual(exclusive.args.slice(-2), ['--', pattern]);
});

test('plan: refuses an unknown task and any option before `--`', () => {
  assert.throws(() => planTestRun([]), /unknown task/);
  assert.throws(() => planTestRun(['test:e2e']), /unknown task/);
  assert.throws(() => planTestRun(['test', '--filter=@rasta/economic-service']), /before `--`/);
});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

test('shellWords honours quotes; scriptCommands splits on &&', () => {
  assert.deepEqual(shellWords(`pnpm run test -- --testNamePattern="(a|b c)" 'x y'`), [
    'pnpm',
    'run',
    'test',
    '--',
    '--testNamePattern=(a|b c)',
    'x y',
  ]);
  assert.throws(() => shellWords('echo "open'), /unterminated/);
  assert.deepEqual(scriptCommands('a b && c'), [['a', 'b'], ['c']]);
});

test('stripJsonComments keeps comment-like text inside strings', () => {
  const parsed = JSON.parse(
    stripJsonComments('{\n  // note\n  "a": "http://x/*y*/", /* b */ "c": 1\n}'),
  );
  assert.deepEqual(parsed, { a: 'http://x/*y*/', c: 1 });
});

test('selectedProjects: named projects, or null for "all"', () => {
  assert.deepEqual(
    selectedProjects(['jest', '--selectProjects', 'unit', 'integration', '--runInBand']),
    ['unit', 'integration'],
  );
  assert.equal(selectedProjects(['jest', '--runInBand']), null);
});

test('projectFiles applies rootDir, testRegex and testPathIgnorePatterns', () => {
  const files = ['src/a.spec.ts', 'test/a.int-spec.ts', `${SPEC}`];
  const project = {
    rootDir: 'test',
    testRegex: '.*\\.int-spec\\.ts$',
    testPathIgnorePatterns: ['a\\.int'],
  };
  assert.deepEqual(projectFiles(project, files, 'services/x'), [SPEC]);
});

test('workflowStepCommands reads inline and block run scalars, dropping comments', () => {
  const yaml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: One',
    '        run: pnpm run one',
    '      - name: Two',
    '        # a comment',
    '        run: |',
    '          # skipped',
    '          pnpm run two',
    '          pnpm run three',
    '        env:',
    '          X: y',
  ].join('\n');
  assert.deepEqual(workflowStepCommands(yaml, 'One'), [['pnpm run one']]);
  assert.deepEqual(workflowStepCommands(yaml, 'Two'), [['pnpm run two', 'pnpm run three']]);
  assert.deepEqual(workflowStepCommands(yaml, 'Missing'), []);
});

test('stressProofTitles finds the two 500-operation proofs in the real spec', () => {
  const titles = stressProofTitles(real().specSource);
  assert.equal(titles.length, 2);
  for (const title of titles) assert.match(title, /\b500\b/);
});

// ---------------------------------------------------------------------------
// The contract, on the real repository and on mutations of it
// ---------------------------------------------------------------------------

test('the real repository satisfies the contract, and the CLI exits 0', () => {
  assert.deepEqual(validateTestPhases(real()), []);
  const run = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('root `test` or `test:integration` straight through turbo is caught', () => {
  for (const task of ['test', 'test:integration']) {
    const inputs = real();
    inputs.rootScripts[task] = `turbo run ${task}`;
    expectProblem(inputs, new RegExp(`root script "${task}" must be exactly`));
    expectProblem(inputs, /runs a workspace test task through turbo directly/);
  }
});

test('a verify that stops running `pnpm run test`, or runs it twice, is caught', () => {
  const inputs = real();
  inputs.rootScripts.verify = inputs.rootScripts.verify.replace(' && pnpm run test && ', ' && ');
  expectProblem(inputs, /"verify" must run `pnpm run test` exactly once \(found 0\)/);

  const twice = real();
  twice.rootScripts.verify = `${twice.rootScripts.verify} && pnpm run test`;
  expectProblem(twice, /exactly once \(found 2\)/);

  const noGate = real();
  noGate.rootScripts.verify = noGate.rootScripts.verify.replace(
    ' && pnpm run check:test-phases',
    '',
  );
  expectProblem(noGate, /"verify" must run `pnpm run check:test-phases`/);
});

test('a missing, renamed or cached exclusive turbo task is caught', () => {
  const missing = real();
  delete missing.turboTasks[EXCLUSIVE_PHASE.task];
  expectProblem(missing, /turbo.json has no "test:aggregation-stress" task/);

  const cached = real();
  delete cached.turboTasks[EXCLUSIVE_PHASE.task].cache;
  expectProblem(cached, /must set "cache": false/);

  const noEnv = real();
  noEnv.turboTasks[EXCLUSIVE_PHASE.task].env = ['REDIS_URL'];
  expectProblem(noEnv, /must pass "DATABASE_URL_\*" through/);

  const noRoot = real();
  delete noRoot.rootScripts[EXCLUSIVE_PHASE.task];
  expectProblem(noRoot, /root script "test:aggregation-stress" must be exactly/);
});

test('the stress spec allowed back into the parallel identity phase is caught', () => {
  // identity `test` selecting every project again.
  const bare = real();
  bare.identityScripts.test = 'jest --passWithNoTests --runInBand';
  expectProblem(bare, /identity script "test" selects the "aggregation-stress" project/);

  // The integration project no longer ignoring the spec. `test` selects only
  // the unit project, so the parallel route that would pick the spec up here
  // is `test:integration`.
  const unignored = real();
  const unignore = (inputs) => {
    inputs.jestProjects.find(
      (project) => project.displayName === 'integration',
    ).testPathIgnorePatterns = ['/node_modules/'];
    return inputs;
  };
  unignore(unignored);
  expectProblem(unignored, /"integration" \(selected by "test:integration"\) collects/);

  // And `test` widened back to the integration project — the pre-2026-09-20
  // shape, when identity's `test` selected `unit integration` and so needed a
  // database. Both the widening and the unignoring are required to reach the
  // spec through `test`, so the fixture applies both.
  const widened = unignore(real());
  widened.identityScripts.test = 'jest --selectProjects unit integration --runInBand';
  expectProblem(widened, /"integration" \(selected by "test"\) collects .*parallel phase/);
});

test('an exclusive phase that selects nothing, or the wrong thing, is caught', () => {
  const removed = real();
  removed.jestProjects = removed.jestProjects.filter(
    (project) => project.displayName !== 'aggregation-stress',
  );
  expectProblem(removed, /has no "aggregation-stress" project/);

  const tolerant = real();
  tolerant.identityScripts[EXCLUSIVE_PHASE.task] += ' --passWithNoTests';
  expectProblem(tolerant, /must not pass with no tests/);

  const wide = real();
  wide.jestProjects.find((project) => project.displayName === 'aggregation-stress').testRegex =
    '.*\\.int-spec\\.ts$';
  expectProblem(wide, /must collect exactly/);

  const gone = real();
  gone.identityFiles = gone.identityFiles.filter((file) => file !== SPEC);
  expectProblem(gone, /does not exist/);

  const untitled = real();
  untitled.specSource = untitled.specSource.replaceAll('500', 'five hundred');
  expectProblem(untitled, /no longer names its two 500-operation proofs/);
});

test('another identity integration spec leaving the parallel phase is caught', () => {
  const inputs = real();
  const integration = inputs.jestProjects.find((project) => project.displayName === 'integration');
  integration.testPathIgnorePatterns = [...integration.testPathIgnorePatterns, 'audit-correction'];
  expectProblem(
    inputs,
    /test\/audit-correction\.int-spec\.ts is not collected by identity "test:integration"/,
  );
});

test('CI losing the exclusive invocation or its security selection is caught', () => {
  const direct = real();
  direct.ciWorkflow = replaceOnce(
    direct.ciWorkflow,
    'run: pnpm run test:integration\n',
    'run: pnpm exec turbo run test:integration\n',
  );
  expectProblem(direct, /"Integration tests" must run `pnpm run test:integration`/);
  expectProblem(direct, /through turbo directly, bypassing the two-phase orchestrator/);

  const narrowed = real();
  narrowed.ciWorkflow = replaceOnce(narrowed.ciWorkflow, '|concurren|', '|');
  expectProblem(narrowed, /pattern no longer selects the stress proof/);

  const dropped = real();
  dropped.ciWorkflow = replaceOnce(
    dropped.ciWorkflow,
    'pnpm run test:integration -- --testNamePattern=',
    'pnpm exec turbo run test:integration -- --testNamePattern=',
  );
  expectProblem(
    dropped,
    /must run `pnpm run test:integration -- --testNamePattern=…` exactly once/,
  );

  const ungated = real();
  ungated.ciWorkflow = replaceOnce(ungated.ciWorkflow, 'pnpm run check:test-phases\n', 'true\n');
  expectProblem(ungated, /CI must run `pnpm run check:test-phases`/);
});

// ---------------------------------------------------------------------------
// The manual ADR-055 calibration campaign stays out of every ordinary gate
// ---------------------------------------------------------------------------

test('calibration: the real repository keeps it manual', () => {
  const inputs = real();
  assert.equal(
    typeof inputs.rootScripts[CALIBRATION_SCRIPT],
    'string',
    'the manual calibration script exists',
  );
  // It is reachable by name only, never from a gate.
  for (const name of ['verify', 'test', 'test:integration', EXCLUSIVE_PHASE.task]) {
    assert.ok(
      !inputs.rootScripts[name].includes(CALIBRATION_SCRIPT),
      `${name} must not reach ${CALIBRATION_SCRIPT}`,
    );
  }
  assert.ok(!inputs.ciWorkflow.includes(CALIBRATION_SCRIPT), 'CI must not run the campaign');
  assert.ok(!inputs.ciWorkflow.includes('--calibrate'), 'CI must not run the campaign');
  assert.deepEqual(validateTestPhases(inputs), []);
});

test('calibration: wiring it into verify, a workspace task or CI is caught', () => {
  for (const name of ['verify', 'test', 'test:integration', EXCLUSIVE_PHASE.task]) {
    const inputs = real();
    inputs.rootScripts[name] = `${inputs.rootScripts[name]} && pnpm run ${CALIBRATION_SCRIPT}`;
    expectProblem(inputs, new RegExp(`"${name}" reaches "${CALIBRATION_SCRIPT}"`));
  }

  const viaName = real();
  viaName.ciWorkflow = replaceOnce(
    viaName.ciWorkflow,
    'pnpm run test:aggregation-evidence-lib',
    `pnpm run test:aggregation-evidence-lib\n          pnpm run ${CALIBRATION_SCRIPT} -- --pairs 3 out.txt`,
  );
  expectProblem(viaName, /manual and must not run in ordinary CI/);

  const viaFlag = real();
  viaFlag.ciWorkflow = replaceOnce(
    viaFlag.ciWorkflow,
    'pnpm run test:aggregation-evidence-lib',
    'pnpm run test:aggregation-evidence-lib\n          node scripts/aggregation-evidence.mjs --calibrate --pairs 3 out.txt',
  );
  expectProblem(viaFlag, /manual and must not run in ordinary CI/);
});

test('calibration: the script itself must stay a bare, pair-count-free entry point', () => {
  const fixedPairs = real();
  fixedPairs.rootScripts[CALIBRATION_SCRIPT] =
    'node scripts/aggregation-evidence.mjs --calibrate --pairs 5';
  expectProblem(fixedPairs, /must not fix a pair count/);

  const wrongTarget = real();
  wrongTarget.rootScripts[CALIBRATION_SCRIPT] = 'node scripts/something-else.mjs --calibrate';
  expectProblem(wrongTarget, /must invoke only/);

  const noFlag = real();
  noFlag.rootScripts[CALIBRATION_SCRIPT] = 'node scripts/aggregation-evidence.mjs';
  expectProblem(noFlag, /must invoke only/);
});

test('calibration: deleting the manual entry point is rejected, not silently accepted', () => {
  // "Manual" means reachable by name only — so the name must exist. Before the
  // contract said so, deleting the script produced no problem at all and the
  // shape rules below it asserted nothing.
  const deleted = real();
  delete deleted.rootScripts[CALIBRATION_SCRIPT];
  expectProblem(deleted, new RegExp(`root script "${CALIBRATION_SCRIPT}" must exist`));

  const emptied = real();
  emptied.rootScripts[CALIBRATION_SCRIPT] = '';
  expectProblem(emptied, new RegExp(`root script "${CALIBRATION_SCRIPT}" must exist`));

  // And the real repository still has it, so the rule is not vacuously green.
  assert.deepEqual(validateTestPhases(real()), []);
});

test('phase one stays infra-free: every services/* "test" selects the unit project only', () => {
  // The real repository, which is the point: this rule guards `pnpm verify`.
  assert.deepEqual(validateInfraFreeTestTask(real().serviceScripts), []);

  const problems = (scripts) => validateInfraFreeTestTask(scripts).join('\n');

  // The two shapes that actually drifted, both caught. The bare `jest` is the
  // quieter one — it passes while a service happens to have no integration
  // spec, then needs a database the day someone writes the first.
  assert.match(
    problems({ 'services/a': { test: 'jest --passWithNoTests' } }),
    /names no project, so it selects every one/,
  );
  assert.match(
    problems({ 'services/b': { test: 'jest --selectProjects unit integration --runInBand' } }),
    /must select exactly the "unit" project \(selects "unit integration"\)/,
  );

  // A `test` that is not jest at all cannot be read, so it is not waved through.
  assert.match(problems({ 'services/c': { test: 'echo skipped' } }), /must run jest/);
  assert.match(problems({ 'services/d': {} }), /must run jest/);

  // The long flag is required, not style preference: `-p` is jest's shorthand
  // for it, and reading only `--selectProjects` means a `-p` script would be
  // judged by a flag it never wrote. Refusing it keeps the rule honest about
  // what it read, and every script in the repository already writes it out.
  assert.match(problems({ 'services/e': { test: 'jest -p unit' } }), /names no project/);
  assert.deepEqual(
    validateInfraFreeTestTask({ 'services/f': { test: 'jest --selectProjects unit --ci' } }),
    [],
  );
});
