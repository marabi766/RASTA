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
  assert.deepEqual(checkBootstrapExample(read('infrastructure/docker/kafka/bootstrap.env.example')), []);
  assert.deepEqual(checkWorkflow(read('.github/workflows/ci.yml')), []);
  assert.deepEqual(checkCiUp(read('infrastructure/docker/kafka/ci-up.sh')), []);
  assert.deepEqual(checkCompose(read('docker-compose.yml')), []);
});

test('the parsers see what they are meant to check', () => {
  const steps = workflowSteps(read('.github/workflows/ci.yml'));
  const starts = steps.filter((step) => step.text.includes('dist/main.js'));
  assert.ok(starts.length >= 2, 'both service start steps are found');
  assert.ok(steps.some((step) => step.name === 'Broker authorisation, asked of the broker'));
  const compose = composeServices(read('docker-compose.yml')).map((service) => service.name);
  for (const name of ['kafka', 'kafka-init', 'kafka-ui', 'kafka-exporter', 'postgres']) {
    assert.ok(compose.includes(name), name);
  }
});

test('.env.example may not hold the admin’s, ops-replay’s, the observer’s or a tool’s password', () => {
  for (const name of ['ADMIN', 'OPS_REPLAY', 'ITEST_OBSERVER', 'KAFKA_UI']) {
    const problems = checkEnvExample(`KAFKA_SASL_PASSWORD_FLEET=x\nKAFKA_SASL_PASSWORD_${name}=y\n`, SERVICES);
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

const step = (name, body) => `      - name: ${name}\n${body}`;

test('CI may not export a Kafka password to later steps or set one in an env block', () => {
  assert.equal(
    checkWorkflow(step('x', '        run: echo "KAFKA_SASL_PASSWORD_FLEET=$p" >> "$GITHUB_ENV"\n')).length,
    1,
  );
  assert.equal(
    checkWorkflow(step('x', '        env:\n          KAFKA_SASL_PASSWORD_ADMIN: ${{ secrets.X }}\n')).length,
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
  const unscoped = step('Start services', '        run: |\n          ( cd services/fleet-service && node dist/main.js & )\n');
  assert.equal(checkWorkflow(unscoped).length, 1);
});

test('only the broker tests take the admin scope', () => {
  const body = '        run: |\n          kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh admin)"\n';
  assert.deepEqual(checkWorkflow(step('Broker authorisation, asked of the broker', body)), []);
  assert.equal(checkWorkflow(step('Integration tests', body)).length, 1);
});

test('ci-up.sh publishes nothing secret', () => {
  const ok = 'publish() {\n  if [ -n "${GITHUB_ENV:-}" ]; then\n    echo "$1=$2" >> "${GITHUB_ENV}"\n  fi\n}\npublish KAFKA_SSL true\n';
  assert.deepEqual(checkCiUp(ok), []);
  assert.equal(checkCiUp(`${ok}publish "\${variable}" "\${value}"\n`).length, 1);
  assert.equal(checkCiUp(`${ok}publish KAFKA_SASL_PASSWORD_ADMIN x\n`).length, 1);
  assert.equal(checkCiUp(`${ok}echo "X=$x" >> "\${GITHUB_ENV}"\n`).length, 1);
});

test('compose gives the bootstrap env file to the broker and kafka-init only, and names none of its secrets', () => {
  const compose = (extra) =>
    `x-kafka-bootstrap-env: &kafka-bootstrap-env\n  - path: x\nservices:\n  kafka:\n    env_file: *kafka-bootstrap-env\n  kafka-init:\n    env_file: *kafka-bootstrap-env\n${extra}volumes:\n  data:\n`;
  assert.deepEqual(checkCompose(compose('')), []);
  assert.equal(checkCompose(compose('  kafka-ui:\n    env_file: *kafka-bootstrap-env\n')).length, 1);
  assert.equal(
    checkCompose(compose('  kafka-ui:\n    environment:\n      KAFKA_SASL_PASSWORD_ADMIN: x\n')).length,
    1,
  );
});

test('kafka-credentials.sh hands out exactly each scope', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'kafka-secrets-'));
  const stem = (principal) => principal.replace(/-service$/, '').replace(/-/g, '_').toUpperCase();
  const principals = read('infrastructure/docker/kafka/principals.development.txt')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  for (const principal of ['admin', ...principals]) {
    writeFileSync(join(dir, `KAFKA_SASL_PASSWORD_${stem(principal)}`), `secret-${principal}`);
  }
  const run = (...args) =>
    spawnSync('bash', [resolve(ROOT, 'infrastructure/docker/kafka/kafka-credentials.sh'), ...args], {
      env: { ...process.env, KAFKA_SECRETS_DIR: dir },
      encoding: 'utf8',
    });
  const variables = (output) => [...output.matchAll(/^export (\w+)=/gm)].map((m) => m[1]).sort();
  try {
    assert.deepEqual(variables(run('service', 'fleet-service').stdout), ['KAFKA_SASL_PASSWORD_FLEET']);
    for (const refused of ['itest-observer', 'ops-replay', 'admin', 'kafka-ui', 'contract-service']) {
      const result = run('service', refused);
      assert.notEqual(result.status, 0, refused);
      assert.equal(result.stdout, '', refused);
    }
    assert.deepEqual(variables(run('observer').stdout), ['KAFKA_SASL_PASSWORD_ITEST_OBSERVER']);
    const tests = variables(run('tests').stdout);
    assert.deepEqual(
      tests,
      [...SERVICES.map((s) => `KAFKA_SASL_PASSWORD_${stem(s)}`), 'KAFKA_SASL_PASSWORD_ITEST_OBSERVER'].sort(),
    );
    for (const name of ['ADMIN', 'OPS_REPLAY', 'KAFKA_UI', 'KAFKA_EXPORTER']) {
      assert.ok(!tests.includes(`KAFKA_SASL_PASSWORD_${name}`), name);
    }
    assert.ok(variables(run('admin').stdout).includes('KAFKA_SASL_PASSWORD_ADMIN'));
    assert.notEqual(run('everything').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
