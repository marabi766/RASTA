import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AGGREGATE_JOB,
  ALLOWED_CONDITIONS,
  SPLIT_STEPS,
  STEP_INVENTORY,
  checkIntegrationSplit,
  checkIntegrationSplitText,
} from './ci-integration-split-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PARSED = parseYaml(TEXT);
const real = () => structuredClone(PARSED);
const fails = (workflow, pattern) => {
  const problems = checkIntegrationSplit(workflow);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`,
  );
};
const splitJobs = (workflow) =>
  Object.keys(workflow.jobs).filter((id) => id.startsWith('integration-'));
const jobRunning = (workflow, name) =>
  splitJobs(workflow).find((id) => workflow.jobs[id].steps.some((step) => step.name === name));
const stepNamed = (workflow, name) =>
  workflow.jobs[jobRunning(workflow, name)].steps.find((step) => step.name === name);
const verdict = (workflow) => workflow.jobs[AGGREGATE_JOB].steps[0];
const dropStep = (job, name) => {
  job.steps = job.steps.filter((step) => step.name !== name);
};
const escape = (text) => text.replace(/[()]/g, '\\$&');

test('the committed workflow passes', () => {
  assert.deepEqual(checkIntegrationSplitText(TEXT), []);
});

test('the parser sees the split it is meant to check', () => {
  const workflow = real();
  assert.ok(splitJobs(workflow).length >= 2);
  assert.equal(workflow.jobs[AGGREGATE_JOB].name, 'Integration and security tests');
  for (const name of SPLIT_STEPS) assert.ok(jobRunning(workflow, name), name);
  assert.ok(workflow.jobs.containers.needs.includes(AGGREGATE_JOB));
  assert.deepEqual(ALLOWED_CONDITIONS, []);
});

test('a split job the aggregate does not need is refused', () => {
  const workflow = real();
  workflow.jobs[AGGREGATE_JOB].needs = workflow.jobs[AGGREGATE_JOB].needs.slice(1);
  fails(workflow, /does not need integration-/);
  const extra = real();
  extra.jobs[AGGREGATE_JOB].needs.push('quality');
  fails(extra, /needs quality, not a split job/);
});

test('an aggregate that runs only on success, or does not check results, is refused', () => {
  const onSuccess = real();
  delete onSuccess.jobs[AGGREGATE_JOB].if;
  fails(onSuccess, /must run if: always\(\)/);
  const notCancelled = real();
  notCancelled.jobs[AGGREGATE_JOB].if = '${{ !cancelled() }}';
  fails(notCancelled, /must run if: always\(\)/);
  const noVerdict = real();
  noVerdict.jobs[AGGREGATE_JOB].steps = [{ name: 'ok', run: 'true' }];
  fails(noVerdict, /must fail unless every needed job's result is "success"/);
  const renamed = real();
  renamed.jobs[AGGREGATE_JOB].name = 'Integration';
  fails(renamed, /must be named "Integration and security tests"/);
});

// The seven in-memory weakenings Codex's review of #274 found accepted.
test('Codex #274: a coverage command replaced by `true` is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate').run = 'true';
  fails(workflow, /"Contract coverage gate" must run exactly/);
});

test('Codex #274: a coverage gate skipped by if: is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate').if = '${{ false }}';
  fails(workflow, /"Contract coverage gate" has if: \$\{\{ false \}\}, which can skip it/);
});

test('Codex #274: a coverage gate whose failure is ignored is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate')['continue-on-error'] = true;
  fails(workflow, /"Contract coverage gate" sets continue-on-error/);
});

test('Codex #274: a skipped verdict is refused', () => {
  const workflow = real();
  verdict(workflow).if = '${{ false }}';
  fails(workflow, /"integration"'s verdict sets if/);
});

test('Codex #274: a verdict whose errors are ignored is refused', () => {
  const workflow = real();
  verdict(workflow)['continue-on-error'] = true;
  fails(workflow, /"integration"'s verdict sets continue-on-error/);
});

test('Codex #274: always() combined with a success requirement is refused', () => {
  const workflow = real();
  workflow.jobs[AGGREGATE_JOB].if =
    "${{ always() && needs.integration-suites.result == 'success' }}";
  fails(workflow, /must run if: always\(\) and nothing else/);
  for (const spelling of ['always()', '${{always()}}', '${{ always() }}']) {
    const same = real();
    same.jobs[AGGREGATE_JOB].if = spelling;
    assert.deepEqual(checkIntegrationSplit(same), [], spelling);
  }
  const wrapped = real();
  wrapped.jobs[AGGREGATE_JOB].if = '${{ always() }} && success()';
  fails(wrapped, /must run if: always\(\) and nothing else/);
});

test('Codex #274: the broker and KAFKA_BROKERS both removed is refused', () => {
  const workflow = real();
  const job = workflow.jobs['integration-coverage-critical'];
  dropStep(job, 'Start the authenticated Kafka broker');
  for (const step of job.steps) if (step.env) delete step.env.KAFKA_BROKERS;
  fails(workflow, /"Contract coverage gate" lost KAFKA_BROKERS from its env/);
});

test('a test command made to pass regardless is refused', () => {
  const variants = [
    (run) => `${run} || true`,
    (run) => run.replace('pnpm run test:integration', 'echo pnpm run test:integration'),
    (run) => run.replace('pnpm run test:integration', 'true # pnpm run test:integration'),
    (run) =>
      run.replace(
        'pnpm run test:integration',
        'pnpm run test:integration -- --passWithNoTests --testPathPattern=none',
      ),
    () => '',
  ];
  for (const variant of variants) {
    const workflow = real();
    const step = stepNamed(workflow, 'Integration tests');
    step.run = variant(step.run);
    fails(workflow, /"Integration tests" must run exactly/);
  }
  const lastLine = real();
  const isolation = stepNamed(lastLine, 'Tenant isolation and authorization tests');
  isolation.run = isolation.run.split('\n').slice(0, 3).join('\n');
  fails(lastLine, /"Tenant isolation and authorization tests" must run exactly/);
});

test('comments and blank lines in a run are not commands', () => {
  const workflow = real();
  const step = stepNamed(workflow, 'Contract coverage gate');
  step.run = `# the gate\n\n${step.run}\n`;
  assert.deepEqual(checkIntegrationSplit(workflow), []);
});

test('a test step that may skip, be forgiven or run in another shell is refused', () => {
  for (const name of SPLIT_STEPS) {
    const conditional = real();
    stepNamed(conditional, name).if = "github.event_name == 'push'";
    fails(conditional, new RegExp(`"${escape(name)}" has if: .*which can skip it`));
    const forgiven = real();
    stepNamed(forgiven, name)['continue-on-error'] = '${{ true }}';
    fails(forgiven, new RegExp(`"${escape(name)}" sets continue-on-error`));
  }
  for (const key of ['shell', 'working-directory']) {
    const workflow = real();
    stepNamed(workflow, 'Audit coverage gate')[key] = key === 'shell' ? 'bash {0}' : 'apps';
    fails(workflow, new RegExp(`"Audit coverage gate" sets ${key}; a test step has only`));
  }
  const explicitFalse = real();
  stepNamed(explicitFalse, 'Audit coverage gate')['continue-on-error'] = false;
  fails(explicitFalse, /sets continue-on-error; a test step has only/);
});

test('a setup step that may skip or be forgiven is refused', () => {
  const skipped = real();
  skipped.jobs['integration-coverage'].steps.find((step) => step.name === 'Apply migrations').if =
    'false';
  fails(skipped, /integration-coverage: "Apply migrations" has if: false/);
  const forgiven = real();
  forgiven.jobs['integration-suites'].steps.find(
    (step) => step.name === 'Start the authenticated Kafka broker',
  )['continue-on-error'] = true;
  fails(
    forgiven,
    /integration-suites: "Start the authenticated Kafka broker" sets continue-on-error/,
  );
});

test('a split job or the aggregate that may skip, be forgiven or fan out is refused', () => {
  for (const id of ['integration-security', AGGREGATE_JOB]) {
    const forgiven = real();
    forgiven.jobs[id]['continue-on-error'] = true;
    fails(forgiven, new RegExp(`^${id} sets continue-on-error`));
    const matrix = real();
    matrix.jobs[id].strategy = { 'fail-fast': false, matrix: { shard: [1, 2] } };
    fails(matrix, new RegExp(`^${id} sets strategy`));
    const shell = real();
    shell.jobs[id].defaults = { run: { shell: 'bash {0}' } };
    fails(shell, new RegExp(`^${id} sets defaults`));
    const unbounded = real();
    delete unbounded.jobs[id]['timeout-minutes'];
    fails(unbounded, new RegExp(`^${id} has no timeout-minutes`));
  }
  const conditional = real();
  conditional.jobs['integration-coverage'].if = "github.event_name == 'pull_request'";
  fails(conditional, /^integration-coverage sets if:/);
  const workflowShell = real();
  workflowShell.defaults = { run: { shell: 'bash {0}' } };
  fails(workflowShell, /the workflow sets defaults/);
});

test('a test step without its time limit, or above it, is refused', () => {
  for (const name of SPLIT_STEPS) {
    const workflow = real();
    delete stepNamed(workflow, name)['timeout-minutes'];
    fails(workflow, new RegExp(`"${escape(name)}" has no timeout-minutes`));
  }
  const raised = real();
  stepNamed(raised, 'Construction coverage gate')['timeout-minutes'] = 9;
  fails(raised, /"Construction coverage gate" has timeout-minutes 9, above its 8/);
  const raisedIntegration = real();
  stepNamed(raisedIntegration, 'Integration tests')['timeout-minutes'] = 17;
  fails(raisedIntegration, /"Integration tests" has timeout-minutes 17, above its 16/);
  const expression = real();
  stepNamed(expression, 'Construction coverage gate')['timeout-minutes'] = '${{ 600 }}';
  fails(expression, /"Construction coverage gate" has no timeout-minutes/);
  const aboveJob = real();
  aboveJob.jobs['integration-suites']['timeout-minutes'] = 10;
  fails(aboveJob, /"Integration tests" has timeout-minutes 16, above its job's 10/);
  const tightened = real();
  stepNamed(tightened, 'Construction coverage gate')['timeout-minutes'] = 7;
  assert.deepEqual(checkIntegrationSplit(tightened), []);
});

test('a test step that loses a declared variable, or changes a pinned one, is refused', () => {
  for (const [name, { env }] of Object.entries(STEP_INVENTORY)) {
    for (const key of Object.keys(env)) {
      const workflow = real();
      delete stepNamed(workflow, name).env[key];
      fails(workflow, new RegExp(`"${escape(name)}" lost ${key} from its env`));
    }
  }
  const optional = real();
  stepNamed(optional, 'Retry replay, published as ops-replay').env.RETRY_REPLAY_REQUIRED = 'false';
  fails(optional, /must set RETRY_REPLAY_REQUIRED: true, not false/);
  const production = real();
  stepNamed(production, 'Economic coverage gate').env.NODE_ENV = 'production';
  fails(production, /"Economic coverage gate" must set NODE_ENV: test/);
});

test('a declared variable set empty, or from an expression that may resolve to empty, is refused', () => {
  const REPLAY = 'Retry replay, published as ops-replay';
  // The review's trigger, in the text: every broker suite would skip.
  const at = TEXT.indexOf(`- name: ${REPLAY}`);
  const brokers = TEXT.indexOf('KAFKA_BROKERS: localhost:9092', at);
  assert.ok(at > 0 && brokers > at);
  const emptied = `${TEXT.slice(0, brokers)}KAFKA_BROKERS: ''${TEXT.slice(brokers + 29)}`;
  assert.deepEqual(checkIntegrationSplitText(emptied), [
    `${jobRunning(PARSED, REPLAY)}: "${REPLAY}" sets KAFKA_BROKERS empty`,
  ]);

  for (const [name, { env }] of Object.entries(STEP_INVENTORY)) {
    for (const key of Object.keys(env)) {
      const workflow = real();
      stepNamed(workflow, name).env[key] = '';
      fails(workflow, new RegExp(`"${escape(name)}" sets ${key} empty`));
    }
  }
  const values = [
    [' ', /sets KAFKA_BROKERS empty/],
    [null, /sets KAFKA_BROKERS to no value/],
    [['localhost:9092'], /sets KAFKA_BROKERS to no value/],
    [
      '${{ secrets.KAFKA_BROKERS }}',
      /sets KAFKA_BROKERS from \$\{\{ secrets\.KAFKA_BROKERS \}\}, which may resolve to empty/,
    ],
    ['${{ vars.KAFKA_BROKERS }}', /from \$\{\{ vars\.KAFKA_BROKERS \}\}, which may resolve/],
    ['localhost:${{env.KAFKA_PORT}}', /from \$\{\{ env\.KAFKA_PORT \}\}, which may resolve/],
    ['localhost:9092${{', /sets KAFKA_BROKERS to an unclosed expression/],
  ];
  for (const [value, pattern] of values) {
    const workflow = real();
    stepNamed(workflow, REPLAY).env.KAFKA_BROKERS = value;
    fails(workflow, pattern);
  }
  const pinned = real();
  stepNamed(pinned, REPLAY).env.RETRY_REPLAY_REQUIRED = '${{ vars.RETRY_REPLAY_REQUIRED }}';
  fails(pinned, /sets RETRY_REPLAY_REQUIRED from \$\{\{ vars\.RETRY_REPLAY_REQUIRED \}\}/);
  const workspace = real();
  stepNamed(workspace, REPLAY).env.KAFKA_SECRETS_DIR = '${{ github.workspace }}/secrets';
  fails(workspace, /sets KAFKA_SECRETS_DIR from \$\{\{ github\.workspace \}\}/);

  // runner.temp is set on every runner; a value built on it is resolved.
  const temp = real();
  stepNamed(temp, REPLAY).env.KAFKA_SECRETS_DIR = '${{runner.temp}}/elsewhere';
  assert.deepEqual(checkIntegrationSplit(temp), []);
});

test('the verdict is run, and one that passes a failed, cancelled or skipped job is refused', () => {
  const rewrite = (from, to) => {
    const workflow = real();
    const step = verdict(workflow);
    assert.ok(step.run.includes(from), from);
    step.run = step.run.replace(from, to);
    return workflow;
  };
  fails(
    rewrite('needs[name].result !== "success"', 'needs[name].result === "failure"'),
    /it passes when integration-suites cancelled/,
  );
  fails(
    rewrite(
      'needs[name].result !== "success"',
      '!["success", "skipped"].includes(needs[name].result)',
    ),
    /it passes when integration-coverage skipped/,
  );
  fails(
    rewrite('const names = Object.keys(needs);', 'const names = Object.keys(needs).slice(0, 1);'),
    /it passes when integration-security failure/,
  );
  fails(
    rewrite('process.exit(1);', 'process.exitCode = 0;'),
    /it passes when every needed job skipped/,
  );
  fails(
    rewrite("node -e '", "node -e 'process.exit(1);"),
    /it fails when every needed job succeeded/,
  );
  const echoed = real();
  verdict(echoed).run = 'echo "$NEEDS"';
  fails(echoed, /it passes when integration-suites failure/);
});

test('a verdict that cannot see the needs context, or is not alone, is refused', () => {
  const partial = real();
  verdict(partial).env.NEEDS = '${{ toJSON(needs.integration-suites) }}';
  fails(partial, /must read the needs context from one env: \$\{\{ toJSON\(needs\) \}\}/);
  const inline = real();
  verdict(inline).run = verdict(inline).run.replace('process.env.NEEDS', "'${{ toJSON(needs) }}'");
  fails(inline, /verdict run has an expression/);
  const second = real();
  second.jobs[AGGREGATE_JOB].steps.push({ name: 'after', run: 'true' });
  fails(second, /must have exactly one step, its verdict/);
  const directory = real();
  verdict(directory)['working-directory'] = 'apps';
  fails(directory, /"integration"'s verdict sets working-directory/);
});

test('the verdict runs here under the shell it names; a pipe that hides its failure is refused', () => {
  const piped = (shell) => {
    const workflow = real();
    const step = verdict(workflow);
    step.run = `${step.run.trimEnd()} | cat\n`;
    if (shell === undefined) delete step.shell;
    else step.shell = shell;
    return workflow;
  };
  // The runner's default options: `| cat` exits 0 with a dependency failed.
  fails(piped('bash -e {0}'), /it passes when integration-suites failure/);
  fails(piped('bash {0}'), /it passes when every needed job skipped/);
  fails(piped(undefined), /verdict must set shell: bash; without it the runner uses bash -e/);
  // With pipefail, as `shell: bash` runs, node's exit status survives the pipe.
  assert.deepEqual(checkIntegrationSplit(piped('bash')), []);
  assert.deepEqual(checkIntegrationSplit(piped('bash --noprofile --norc -eo pipefail {0}')), []);
  // The committed script is one command, right under any of them.
  const plain = real();
  verdict(plain).shell = 'bash -e {0}';
  assert.deepEqual(checkIntegrationSplit(plain), []);
});

test('a verdict whose shell is unset, or not one it can be run under here, is refused', () => {
  const unset = real();
  delete verdict(unset).shell;
  fails(unset, /"integration"'s verdict must set shell: bash; without it/);
  for (const shell of [
    'sh',
    'pwsh',
    'python',
    'node {0}',
    'bash -e',
    'bash -c "exit 0" {0}',
    'bash $X {0}',
    ['bash'],
  ]) {
    const workflow = real();
    verdict(workflow).shell = shell;
    fails(workflow, /"integration"'s verdict must set shell: bash, or "bash <options> \{0\}", not/);
  }
});

test('a step dropped from every job, or run twice, is refused', () => {
  for (const name of ['Contract coverage gate', 'Retry replay, published as ops-replay']) {
    const workflow = real();
    dropStep(workflow.jobs[jobRunning(workflow, name)], name);
    fails(workflow, new RegExp(`runs "${escape(name)}"`));
  }
  const twice = real();
  twice.jobs['integration-suites'].steps.push(
    structuredClone(stepNamed(twice, 'Audit coverage gate')),
  );
  fails(twice, /"Audit coverage gate" runs in more than one job/);
});

test('a step without its infrastructure is refused', () => {
  const documentJob = (workflow) => workflow.jobs[jobRunning(workflow, 'Document coverage gate')];
  const noScanner = real();
  dropStep(documentJob(noScanner), 'Start ClamAV on a Unix socket');
  fails(noScanner, /"Document coverage gate" runs without "Start ClamAV on a Unix socket"/);
  const noBucket = real();
  dropStep(documentJob(noBucket), 'Start MinIO and create the document bucket');
  fails(noBucket, /"Document coverage gate" runs without "Start MinIO/);
  const noBroker = real();
  dropStep(documentJob(noBroker), 'Start the authenticated Kafka broker');
  fails(noBroker, /runs without "Start the authenticated Kafka broker"/);
  const noMigrations = real();
  dropStep(documentJob(noMigrations), 'Apply migrations');
  fails(noMigrations, /runs without "Apply migrations"/);
  const noRedis = real();
  delete noRedis.jobs[jobRunning(noRedis, 'Integration tests')].services.redis;
  fails(noRedis, /"Integration tests" runs without a redis service container/);
  const noBuild = real();
  dropStep(documentJob(noBuild), 'Build the shared packages');
  fails(noBuild, /needs the packages built before it/);
});

test('infrastructure no step of the job reads is refused', () => {
  const workflow = real();
  const id = jobRunning(workflow, 'Construction coverage gate');
  workflow.jobs[id].services.redis = { image: 'redis' };
  fails(workflow, new RegExp(`${id} starts Redis, which no step of it reads`));
});

test('the notification SMTP suites cannot skip: Mailpit is provisioned and required', () => {
  for (const name of ['Integration tests', 'Notification coverage gate']) {
    const noMailpit = real();
    delete noMailpit.jobs[jobRunning(noMailpit, name)].services.mailpit;
    fails(noMailpit, new RegExp(`"${name}" runs without a mailpit service container`));

    const notRequired = real();
    delete stepNamed(notRequired, name).env.REQUIRE_MAILPIT;
    fails(notRequired, new RegExp(`"${name}" lost REQUIRE_MAILPIT from its env`));

    const optional = real();
    stepNamed(optional, name).env.REQUIRE_MAILPIT = '0';
    fails(optional, new RegExp(`"${name}" must set REQUIRE_MAILPIT: 1, not 0`));
  }
  const unread = real();
  const id = jobRunning(unread, 'Construction coverage gate');
  unread.jobs[id].services.mailpit = { image: 'axllent/mailpit' };
  fails(unread, new RegExp(`${id} starts Mailpit, which no step of it reads`));
});

test('invalid YAML is a problem, not a pass', () => {
  assert.equal(checkIntegrationSplitText('jobs: [unclosed').length, 1);
});
