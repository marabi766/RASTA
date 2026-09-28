import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBootstrapExample,
  checkCiUp,
  checkCompose,
  checkEnvExample,
  checkLocalEnv,
  checkWorkflow,
  composeServices,
  workflowSteps,
} from './check-kafka-credential-scope-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const SERVICES = read('infrastructure/docker/kafka/principals.development.txt')
  .split('\n')
  .filter((line) => line.endsWith('-service'));

test('the committed files give no service a Kafka credential but its own', () => {
  assert.deepEqual(checkEnvExample(read('.env.example'), SERVICES), []);
  assert.deepEqual(
    checkBootstrapExample(read('infrastructure/docker/kafka/bootstrap.env.example')),
    [],
  );
  assert.deepEqual(checkWorkflow(read('.github/workflows/ci.yml')), []);
  assert.deepEqual(checkCiUp(read('infrastructure/docker/kafka/ci-up.sh')), []);
  assert.deepEqual(checkCompose(read('docker-compose.yml')), []);
});

test('the parsers see what they are meant to check', () => {
  const steps = workflowSteps(read('.github/workflows/ci.yml'));
  const starts = steps.filter((step) => step.run.includes('dist/main.js'));
  assert.ok(starts.length >= 2, 'both service start steps are found');
  assert.ok(steps.some((step) => step.name === 'Broker authorisation, asked of the broker'));
  // Unnamed steps are seen too (`- run: pnpm run db:generate` and the like).
  assert.ok(
    steps.some((step) => /^[a-z-]+ step \d+/.test(step.name)),
    'unnamed steps are listed',
  );
  const compose = composeServices(read('docker-compose.yml')).map((service) => service.name);
  for (const name of ['kafka', 'kafka-init', 'kafka-ui', 'kafka-exporter', 'postgres']) {
    assert.ok(compose.includes(name), name);
  }
});

test('.env.example may not hold the admin’s, ops-replay’s, the observer’s or a tool’s password', () => {
  for (const name of ['ADMIN', 'OPS_REPLAY', 'ITEST_OBSERVER', 'KAFKA_UI']) {
    const problems = checkEnvExample(
      `KAFKA_SASL_PASSWORD_FLEET=x\nKAFKA_SASL_PASSWORD_${name}=y\n`,
      SERVICES,
    );
    assert.equal(problems.length, 1, name);
  }
  assert.deepEqual(checkEnvExample('# KAFKA_SASL_PASSWORD_ADMIN=commented\n', SERVICES), []);
});

test('the bootstrap example holds exactly the bootstrap-only credentials', () => {
  assert.equal(checkBootstrapExample('KAFKA_SASL_PASSWORD_ADMIN=a\n').length, 1);
  assert.equal(
    checkBootstrapExample(
      'KAFKA_SASL_PASSWORD_ADMIN=a\nKAFKA_SASL_PASSWORD_OPS_REPLAY=b\nKAFKA_SASL_PASSWORD_ITEST_OBSERVER=c\nKAFKA_SASL_PASSWORD_FLEET=d\n',
    ).length,
    1,
  );
});

/** A workflow with one job whose steps are `fragments` (each at step indentation). */
const workflow = (...fragments) => `jobs:\n  j:\n    runs-on: x\n    steps:\n${fragments.join('')}`;
const step = (name, body) => workflow(`      - name: ${name}\n${body}`);

test('CI may not export a Kafka password to later steps or set one in an env block', () => {
  assert.equal(
    checkWorkflow(step('x', '        run: echo "KAFKA_SASL_PASSWORD_FLEET=$p" >> "$GITHUB_ENV"\n'))
      .length,
    1,
  );
  assert.equal(
    checkWorkflow(
      step('x', '        env:\n          KAFKA_SASL_PASSWORD_ADMIN: ${{ secrets.X }}\n'),
    ).length,
    1,
  );
});

test('a service start step takes exactly that service’s own scope', () => {
  const start = (scope, service) =>
    step(
      'Start services',
      `        run: |\n          ( kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh ${scope})" && \\\n            eval "$kafka_credentials" && \\\n            cd services/${service} && \\\n            node dist/main.js & )\n`,
    );
  assert.deepEqual(checkWorkflow(start('service fleet-service', 'fleet-service')), []);
  assert.equal(checkWorkflow(start('service asset-service', 'fleet-service')).length, 1);
  assert.ok(checkWorkflow(start('tests', 'fleet-service')).length >= 1);
  assert.ok(checkWorkflow(start('admin', 'fleet-service')).length >= 1);
  const unscoped = step(
    'Start services',
    '        run: |\n          ( cd services/fleet-service && node dist/main.js & )\n',
  );
  assert.equal(checkWorkflow(unscoped).length, 1);
});

test('only the broker tests take the admin scope', () => {
  const body =
    '        run: |\n          kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh admin)"\n';
  assert.deepEqual(checkWorkflow(step('Broker authorisation, asked of the broker', body)), []);
  assert.equal(checkWorkflow(step('Integration tests', body)).length, 1);
});

test('ci-up.sh publishes nothing secret', () => {
  const ok =
    'publish() {\n  if [ -n "${GITHUB_ENV:-}" ]; then\n    echo "$1=$2" >> "${GITHUB_ENV}"\n  fi\n}\npublish KAFKA_SSL true\n';
  assert.deepEqual(checkCiUp(ok), []);
  assert.equal(checkCiUp(`${ok}publish "\${variable}" "\${value}"\n`).length, 1);
  assert.equal(checkCiUp(`${ok}publish KAFKA_SASL_PASSWORD_ADMIN x\n`).length, 1);
  assert.equal(checkCiUp(`${ok}echo "X=$x" >> "\${GITHUB_ENV}"\n`).length, 1);
});

test('compose gives the bootstrap env file to the broker and kafka-init only, and names none of its secrets', () => {
  const compose = (extra) =>
    `x-kafka-bootstrap-env: &kafka-bootstrap-env\n  - path: x\nservices:\n  kafka:\n    env_file: *kafka-bootstrap-env\n  kafka-init:\n    env_file: *kafka-bootstrap-env\n${extra}volumes:\n  data:\n`;
  assert.deepEqual(checkCompose(compose('')), []);
  assert.equal(
    checkCompose(compose('  kafka-ui:\n    env_file: *kafka-bootstrap-env\n')).length,
    1,
  );
  assert.equal(
    checkCompose(compose('  kafka-ui:\n    environment:\n      KAFKA_SASL_PASSWORD_ADMIN: x\n'))
      .length,
    1,
  );
});

test('a developer’s .env may hold no Kafka credential but a service’s own', () => {
  for (const name of [
    'ADMIN',
    'OPS_REPLAY',
    'ITEST_OBSERVER',
    'KAFKA_UI',
    'KAFKA_EXPORTER',
    'ANYTHING_ELSE',
  ]) {
    assert.equal(checkLocalEnv(`KAFKA_SASL_PASSWORD_${name}=x\n`, SERVICES).length, 1, name);
    assert.equal(checkLocalEnv(`export KAFKA_SASL_PASSWORD_${name}=x\n`, SERVICES).length, 1, name);
  }
  assert.deepEqual(
    checkLocalEnv('KAFKA_SASL_PASSWORD_FLEET=x\n# KAFKA_SASL_PASSWORD_KAFKA_UI=y\n', SERVICES),
    [],
  );
  // Every service's own, as .env.example has them, passes.
  assert.deepEqual(checkLocalEnv(read('.env.example'), SERVICES), []);
});

test('neither secrets directory reaches $GITHUB_ENV or a job- or workflow-level env', () => {
  for (const dir of ['KAFKA_SECRETS_DIR', 'KAFKA_ADMIN_SECRETS_DIR']) {
    assert.ok(
      checkWorkflow(step('x', `        run: echo "${dir}=/tmp/s" >> "$GITHUB_ENV"\n`)).some(
        (problem) => problem.startsWith(`"x" exports ${dir} to later steps`),
      ),
      dir,
    );
    const job = `jobs:\n  integration:\n    env:\n      ${dir}: /tmp/s\n    steps:\n      - run: true\n`;
    assert.ok(checkWorkflow(job).length >= 1, `${dir} at job level`);
    assert.ok(
      checkWorkflow(`env:\n  ${dir}: /tmp/s\njobs: {}\n`).length >= 1,
      `${dir} at workflow level`,
    );
    // Flow style is the same mapping (review of #131, verify pass).
    const flow = `jobs:\n  x:\n    env: { ${dir}: /tmp/s }\n    steps:\n      - run: true\n`;
    assert.ok(
      checkWorkflow(flow).some((problem) => problem.includes(`sets ${dir} in job "x"'s env`)),
      `${dir} in a flow-style job env`,
    );
    const container = `jobs:\n  x:\n    services:\n      db:\n        image: y\n        env: { ${dir}: /tmp/s }\n    steps: []\n`;
    assert.ok(checkWorkflow(container).length >= 1, `${dir} in a service container's env`);
  }
  assert.equal(
    checkCiUp(
      'publish() {\n  if [ -n "${GITHUB_ENV:-}" ]; then\n    echo "$1=$2" >> "${GITHUB_ENV}"\n  fi\n}\npublish KAFKA_SECRETS_DIR "${SECRETS_DIR}"\n',
    ).length,
    1,
  );
});

test('the admin’s secrets directory goes to the broker bootstrap and the broker tests alone', () => {
  const given = (name) =>
    checkWorkflow(
      step(
        name,
        '        run: bash infrastructure/docker/kafka/kafka-credentials.sh admin\n        env:\n          KAFKA_ADMIN_SECRETS_DIR: /tmp/a\n',
      ),
    );
  assert.deepEqual(given('Broker authorisation, asked of the broker'), []);
  assert.ok(given('Integration tests').some((problem) => /KAFKA_ADMIN_SECRETS_DIR/.test(problem)));
});

test('a step is given KAFKA_SECRETS_DIR only to call kafka-credentials.sh or ci-up.sh', () => {
  const env = '        env:\n          KAFKA_SECRETS_DIR: /tmp/s\n';
  assert.equal(checkWorkflow(step('x', `        run: pnpm test\n${env}`)).length, 1);
  assert.deepEqual(
    checkWorkflow(
      step('x', `        run: bash infrastructure/docker/kafka/kafka-credentials.sh tests\n${env}`),
    ),
    [],
  );
});

test('a service start step unsets the secrets directory before it launches anything', () => {
  const env = '        env:\n          KAFKA_SECRETS_DIR: /tmp/s\n';
  const launch =
    '          ( kafka_credentials="$(KAFKA_SECRETS_DIR="${kafka_secrets_dir}" bash infrastructure/docker/kafka/kafka-credentials.sh service fleet-service)" && \\\n' +
    '            eval "$kafka_credentials" && \\\n            cd services/fleet-service && \\\n            node dist/main.js & )\n';
  const gateway = '          ( cd services/api-gateway && node dist/main.js & )\n';
  const unset =
    '          kafka_secrets_dir="${KAFKA_SECRETS_DIR}"\n          unset KAFKA_SECRETS_DIR\n';
  const start = (body) => step('Start services', `${env}        run: |\n${body}`);
  assert.deepEqual(checkWorkflow(start(unset + launch + gateway)), []);
  assert.equal(checkWorkflow(start(launch + gateway)).length, 1, 'never unset');
  assert.equal(checkWorkflow(start(gateway + unset + launch)).length, 1, 'unset after a launch');
});

test('an unnamed step, or one written in flow style, is checked like any other', () => {
  // Review of #131, verify pass: `- env: {KAFKA_SECRETS_DIR: …} run: node dist/main.js`.
  const unnamed = workflow(
    '      - env: { KAFKA_SECRETS_DIR: /tmp/s }\n        run: bash infrastructure/docker/kafka/kafka-credentials.sh service fleet-service; cd services/fleet-service && node dist/main.js\n',
  );
  assert.ok(
    checkWorkflow(unnamed).some((problem) =>
      /"j step 1" starts services without first unsetting KAFKA_SECRETS_DIR/.test(problem),
    ),
  );
  const unnamedAdmin = workflow(
    '      - { env: { KAFKA_ADMIN_SECRETS_DIR: /tmp/a }, run: pnpm test }\n',
  );
  assert.ok(
    checkWorkflow(unnamedAdmin).some((problem) =>
      /"j step 1" is given KAFKA_ADMIN_SECRETS_DIR/.test(problem),
    ),
  );
  const flowPassword = workflow(
    '      - { name: y, env: { KAFKA_SASL_PASSWORD_ADMIN: z }, run: true }\n',
  );
  assert.ok(
    checkWorkflow(flowPassword).some((problem) => /sets KAFKA_SASL_PASSWORD_ADMIN/.test(problem)),
  );
  assert.equal(checkWorkflow('jobs: [unclosed').length, 1, 'invalid YAML is a problem, not a pass');
});

test('the real workflow fails the check when a start step keeps the directory or a test step takes the admin’s', () => {
  const real = read('.github/workflows/ci.yml');
  const kept = real.replaceAll('          unset KAFKA_SECRETS_DIR\n', '');
  assert.notEqual(kept, real);
  assert.ok(checkWorkflow(kept).some((problem) => /without first unsetting/.test(problem)));
  const widened = real.replace(
    '          pnpm run test:integration\n        env:\n',
    '          pnpm run test:integration\n        env:\n          KAFKA_ADMIN_SECRETS_DIR: ${{ runner.temp }}/rasta-kafka-admin-secrets\n',
  );
  assert.notEqual(widened, real);
  assert.ok(
    checkWorkflow(widened).some((problem) =>
      /"Integration tests" is given KAFKA_ADMIN_SECRETS_DIR/.test(problem),
    ),
  );
});

test('kafka-credentials.sh hands out exactly each scope, each from its own directory', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const services = mkdtempSync(join(tmpdir(), 'kafka-secrets-'));
  const admins = mkdtempSync(join(tmpdir(), 'kafka-admin-secrets-'));
  const stem = (principal) =>
    principal
      .replace(/-service$/, '')
      .replace(/-/g, '_')
      .toUpperCase();
  const principals = read('infrastructure/docker/kafka/principals.development.txt')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  // As ci-up.sh writes them: a service's and the observer's apart from the rest.
  for (const principal of ['admin', ...principals]) {
    const dir = /-service$|^itest-observer$/.test(principal) ? services : admins;
    writeFileSync(join(dir, `KAFKA_SASL_PASSWORD_${stem(principal)}`), `secret-${principal}`);
  }
  const run = (env, ...args) =>
    spawnSync(
      'bash',
      [resolve(ROOT, 'infrastructure/docker/kafka/kafka-credentials.sh'), ...args],
      {
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
      },
    );
  const both = { KAFKA_SECRETS_DIR: services, KAFKA_ADMIN_SECRETS_DIR: admins };
  const variables = (output) => [...output.matchAll(/^export (\w+)=/gm)].map((m) => m[1]).sort();
  try {
    assert.deepEqual(variables(run(both, 'service', 'fleet-service').stdout), [
      'KAFKA_SASL_PASSWORD_FLEET',
    ]);
    for (const refused of [
      'itest-observer',
      'ops-replay',
      'admin',
      'kafka-ui',
      'contract-service',
    ]) {
      const result = run(both, 'service', refused);
      assert.notEqual(result.status, 0, refused);
      assert.equal(result.stdout, '', refused);
    }
    assert.deepEqual(variables(run(both, 'observer').stdout), [
      'KAFKA_SASL_PASSWORD_ITEST_OBSERVER',
    ]);
    const tests = variables(run(both, 'tests').stdout);
    assert.deepEqual(
      tests,
      [
        ...SERVICES.map((s) => `KAFKA_SASL_PASSWORD_${stem(s)}`),
        'KAFKA_SASL_PASSWORD_ITEST_OBSERVER',
      ].sort(),
    );
    for (const name of ['ADMIN', 'OPS_REPLAY', 'KAFKA_UI', 'KAFKA_EXPORTER']) {
      assert.ok(!tests.includes(`KAFKA_SASL_PASSWORD_${name}`), name);
    }
    // Every scope but admin works with the services' directory alone.
    assert.equal(run({ KAFKA_SECRETS_DIR: services }, 'tests').status, 0);
    const admin = variables(run(both, 'admin').stdout);
    assert.deepEqual(
      admin,
      ['admin', ...principals].map((p) => `KAFKA_SASL_PASSWORD_${stem(p)}`).sort(),
    );
    // Without the admin's directory there is no admin scope; without a
    // directory at all, nothing.
    const withoutAdminDir = run({ KAFKA_SECRETS_DIR: services }, 'admin');
    assert.notEqual(withoutAdminDir.status, 0);
    assert.equal(withoutAdminDir.stdout, '');
    assert.notEqual(run({}, 'service', 'fleet-service').status, 0);
    assert.notEqual(run(both, 'everything').status, 0);
  } finally {
    rmSync(services, { recursive: true, force: true });
    rmSync(admins, { recursive: true, force: true });
  }
});
