/**
 * The disposable-broker declaration (PR #378 r5 F2, disposable-broker.mjs):
 * all four broker suites that change a broker beyond topics of their own refuse to
 * start without RASTA_DISPOSABLE_BROKER=1 — run directly, under `node --test`
 * and through their package command — with a non-zero exit, before any Docker
 * command or Kafka connection. No broker needed: `docker` is a recorder on
 * PATH, and KAFKA_BROKERS points at a socket that counts connections. Every
 * other setting the tests ask for is present, so the declaration is what
 * stops them.
 *
 *   node --test scripts/disposable-broker.test.mjs
 */
import YAML from 'yaml';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECLARATION = 'RASTA_DISPOSABLE_BROKER';
const FILES = [
  'scripts/create-topics.broker.test.mjs',
  'scripts/dead-letter-escape.broker.test.mjs',
  'scripts/replay-dlq.broker.test.mjs',
  'scripts/kafka-acl.broker.test.mjs',
];
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

let work;
let dockerLog;
let connections = 0;
let server;
let broker;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'disposable-broker-'));
  dockerLog = join(work, 'docker.calls');
  writeFileSync(dockerLog, '');
  const docker = join(work, 'docker');
  writeFileSync(docker, `#!/bin/sh\necho "docker $*" >> '${dockerLog}'\nexit 0\n`);
  chmodSync(docker, 0o755);
  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  broker = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
  rmSync(work, { recursive: true, force: true });
});

/** Everything the broker tests ask for but the declaration, set to `declared` (undefined: unset). */
function environment(declared) {
  const env = {
    ...process.env,
    PATH: `${work}${delimiter}${process.env.PATH}`,
    KAFKA_BROKERS: broker,
    KAFKA_CONTAINER_NAME: 'disposable-broker-test',
    KAFKA_SASL_PASSWORD_ADMIN: 'x',
    KAFKA_SASL_PASSWORD_ORGANIZATION: 'x',
    KAFKA_SASL_PASSWORD_AUDIT: 'x',
  };
  delete env[DECLARATION];
  delete env.NODE_TEST_CONTEXT;
  if (declared !== undefined) env[DECLARATION] = declared;
  return env;
}

function run(command, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, env });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', fail);
    child.on('close', (status) => done({ status, output }));
  });
}

async function assertRefused(command, args, declared, files = 1) {
  const before = connections;
  const { status, output } = await run(command, args, environment(declared));
  assert.notEqual(status, 0, output);
  const refusals =
    output.match(/refusing to run — it changes the broker beyond topics of its own/g) ?? [];
  assert.equal(refusals.length, files, output);
  assert.match(output, /with RASTA_DISPOSABLE_BROKER=1 .*Nothing was run\./);
  assert.equal(readFileSync(dockerLog, 'utf8'), '', 'a Docker command ran');
  assert.equal(connections, before, 'a Kafka connection was opened');
}

for (const declared of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
  const label = declared === undefined ? 'unset' : JSON.stringify(declared);
  for (const file of FILES) {
    test(`${file}, run directly, ${DECLARATION} ${label}: refused, non-zero, no Docker, no Kafka`, () =>
      assertRefused(process.execPath, [file], declared));
  }
}

for (const file of FILES) {
  test(`${file} under node --test, undeclared: refused`, () =>
    assertRefused(process.execPath, ['--test', file], undefined));
}

for (const [command, files] of [
  ['test:kafka-limits-broker', 2],
  ['test:replay-dlq-broker', 1],
  ['test:kafka-acl-broker', 1],
]) {
  for (const declared of [undefined, '', '0', 'true', ' 1', '1 ']) {
    test(`package ${command}, declaration ${JSON.stringify(declared)}: refuses before Docker/network`, () =>
      assertRefused('pnpm', ['run', '--silent', command], declared, files));
  }
}

test('each broker test imports the declaration first, before anything else it runs', () => {
  for (const file of FILES) {
    const firstImport = read(file).match(/^import .*$/m)?.[0];
    assert.equal(firstImport, "import './disposable-broker.mjs';", file);
  }
});

test('declared exactly "1", the guard lets the file go on (the refusals above are not vacuous)', async () => {
  const probe = join(work, 'probe.mjs');
  writeFileSync(
    probe,
    `import ${JSON.stringify(resolve(ROOT, 'scripts/disposable-broker.mjs'))};\nconsole.log('went on');\n`,
  );
  const { status, output } = await run(process.execPath, [probe], environment('1'));
  assert.equal(status, 0, output);
  assert.match(output, /went on/);
});

test('CI declares it once for all four suites in the broker step alone; no env file/package script does', () => {
  const ci = YAML.parse(read('.github/workflows/ci.yml'));
  assert.ok(!Object.hasOwn(ci.env ?? {}, DECLARATION), 'no workflow-level declaration');
  const declarations = [];
  for (const [name, job] of Object.entries(ci.jobs)) {
    assert.ok(!Object.hasOwn(job.env ?? {}, DECLARATION), `${name} job-level declaration`);
    for (const step of job.steps ?? []) {
      if (Object.hasOwn(step.env ?? {}, DECLARATION)) declarations.push({ name, step });
      assert.ok(!step.run?.includes(`${DECLARATION}=`), 'no inline/default declaration');
    }
  }
  assert.equal(declarations.length, 1);
  const [{ name, step }] = declarations;
  assert.equal(name, 'broker-authorisation');
  assert.equal(step.env[DECLARATION], '1');
  for (const command of [
    'test:replay-dlq-broker',
    'test:kafka-acl-broker',
    'test:kafka-limits-broker',
  ]) {
    assert.ok(step.run.includes(`pnpm run ${command}`));
  }
  assert.ok(!read('scripts/replay-dlq.broker.test.mjs').includes('REPLAY_TEST_DISPOSABLE_BROKER'));
  for (const path of [
    'infrastructure/docker/kafka/bootstrap.env.example',
    '.env.example',
    'package.json',
  ]) {
    assert.ok(!read(path).includes(DECLARATION), `${path} declares ${DECLARATION}`);
  }
});
