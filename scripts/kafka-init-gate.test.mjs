import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/kafka-init-gate.mjs');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const ID = 'a'.repeat(64);
const NEW_ID = 'b'.repeat(64);
const OLD = '2026-01-01T00:00:00.000000000Z';
const NEW = '2026-01-02T00:00:00.000000000Z';
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const path = process.env.GATE_FIXTURE;
const data = JSON.parse(fs.readFileSync(path));
const args = process.argv.slice(2);
data.calls.push(args);
const save = () => fs.writeFileSync(path, JSON.stringify(data));
const fail = () => { process.stderr.write('foreign diagnostic never printed'); save(); process.exit(9); };
let output;
if (args[0] === 'compose' && args[1] === 'ps') {
  if (data.lookupFailure) fail();
  output = data.up ? data.missing ? '' : data.multiple ? '${ID}\\n${NEW_ID}' : data.replaced && data.waited ? '${NEW_ID}' : '${ID}' : data.existing ? '${ID}' : '';
} else if (args[0] === 'compose' && args[1] === 'up') {
  if (data.startFailure) fail();
  data.up = true;
} else if (args[0] === 'inspect') {
  if (data.inspectFailure || data.finalInspectFailure && data.waited) fail();
  if (data.malformed) output = '{';
  else {
    const running = data.up ? !data.waited || data.stillRunning : data.alreadyRunning;
    const state = { Running: !!running, Status: running ? 'running' : 'exited',
      StartedAt: data.up && !data.stale ? data.restarted && data.waited ? '${OLD}' : data.nextStart ?? '${NEW}' : data.previousStart ?? '${OLD}',
      ExitCode: data.waited ? data.mismatch ? 0 : data.exitCode ?? 0 : 0,
      Dead: false, OOMKilled: false, Restarting: false, ...data.stateOverride };
    output = JSON.stringify(state);
  }
} else if (args[0] === 'wait') {
  if (args[1] !== '${ID}') fail();
  if (data.waitFailure) fail();
  if (data.timeout) { save(); setTimeout(() => {}, 5000); return; }
  data.waited = true;
  output = data.badWait ?? String(data.exitCode ?? 0);
} else fail();
save();
if (output !== undefined) process.stdout.write(output + '\\n');
`;

async function probe(scenario = {}, { args = [], timeout = '5000', twice = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kafka-init-gate-'));
  try {
    const fixture = join(dir, 'fixture.json');
    writeFileSync(fixture, JSON.stringify({ ...scenario, calls: [] }));
    const docker = join(dir, 'docker');
    writeFileSync(docker, FAKE);
    chmodSync(docker, 0o755);
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      GATE_FIXTURE: fixture,
      RASTA_KAFKA_INIT_TIMEOUT_MS: timeout,
    };
    const run = () =>
      new Promise((done, fail) => {
        // The following ACL step must never mask a failed provisioner.
        const child = spawn(
          'bash',
          [
            '-c',
            '"$1" "$2" "${@:3}" && printf ACL_RAN',
            'gate-test',
            process.execPath,
            SCRIPT,
            ...args,
          ],
          { cwd: ROOT, env },
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('error', fail);
        child.on('close', (status) => done({ status, output }));
      });
    const first = await run();
    if (twice) {
      const data = JSON.parse(readFileSync(fixture));
      writeFileSync(
        fixture,
        JSON.stringify({
          ...data,
          existing: true,
          up: false,
          waited: false,
          previousStart: NEW,
          nextStart: '2026-01-03T00:00:00.000000000Z',
        }),
      );
      first.second = await run();
    }
    return { ...first, ...JSON.parse(readFileSync(fixture)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('successful fake kafka-init is awaited by exact ID before ACLs run', async () => {
  const result = await probe();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /topic provisioning confirmed.*\nACL_RAN/);
  assert.deepEqual(
    result.calls.find((call) => call[0] === 'wait'),
    ['wait', ID],
  );
  assert.ok(result.calls.filter((call) => call[0] === 'inspect').length >= 2);
});

test('failed fake kafka-init propagates its exact exit status; following ACLs cannot run', async () => {
  const result = await probe({ exitCode: 37 });
  assert.equal(result.status, 37, result.output);
  assert.match(result.output, /kafka-init exited 37/);
  assert.doesNotMatch(result.output, /ACL_RAN|completed successfully/);
});

for (const [label, scenario, message] of [
  ['missing initializer', { missing: true }, /missing or ambiguous/],
  ['ambiguous initializer', { multiple: true }, /missing or ambiguous/],
  ['lookup fails', { lookupFailure: true }, /locate kafka-init/],
  ['inspect fails', { inspectFailure: true }, /inspect kafka-init/],
  ['final inspect fails', { finalInspectFailure: true }, /inspect kafka-init/],
  ['inspect malformed', { malformed: true }, /unreadable kafka-init state/],
  ['wait fails', { waitFailure: true }, /wait for kafka-init/],
  ['wait malformed', { badWait: '0\n0' }, /unreadable kafka-init wait/],
  ['wait out of range', { badWait: '256' }, /unreadable kafka-init wait/],
  ['compose startup fails', { startFailure: true }, /compose startup/],
  ['stale prior success', { existing: true, stale: true }, /did not start a new/],
  ['already running', { existing: true, alreadyRunning: true }, /already running/],
  ['container replaced while waiting', { replaced: true }, /different or unconfirmed/],
  ['container restarted while waiting', { restarted: true }, /different or unconfirmed/],
  ['still running after wait', { stillRunning: true }, /different or unconfirmed/],
  ['exit code disagrees', { exitCode: 37, mismatch: true }, /different or unconfirmed/],
  ['dead container', { stateOverride: { Dead: true } }, /unconfirmed kafka-init state/],
  ['OOM container', { stateOverride: { OOMKilled: true } }, /unconfirmed kafka-init state/],
  ['restarting container', { stateOverride: { Restarting: true } }, /unconfirmed kafka-init state/],
  ['never started', { stateOverride: { StartedAt: '0001-01-01T00:00:00Z' } }, /did not start/],
  ['missing state field', { stateOverride: { Running: null } }, /unconfirmed kafka-init state/],
]) {
  test(`${label}: fail closed without running ACLs or disclosing Docker output`, async () => {
    const result = await probe(scenario);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /ACL_RAN|completed successfully|foreign diagnostic/);
  });
}

test('timeout kills only the waiting CLI, returns 124, and never resets or retries provisioning', async () => {
  const result = await probe({ timeout: true }, { timeout: '1200' });
  assert.equal(result.status, 124, result.output);
  assert.match(result.output, /wait for kafka-init timed out/);
  assert.equal(result.calls.filter((call) => call[1] === 'up').length, 1);
  assert.doesNotMatch(result.calls.flat().join(' '), /\b(down|kill|stop|rm|restart)\b/);
});

test('repeated startup requires and awaits each new invocation of the same container', async () => {
  const result = await probe({}, { twice: true });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.second.status, 0, result.second.output);
  assert.equal(result.calls.filter((call) => call[0] === 'wait').length, 2);
});

test('targeted runbook startup always includes the initializer', async () => {
  const result = await probe({}, { args: ['kafka'] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    result.calls.find((call) => call[1] === 'up'),
    ['compose', 'up', '-d', 'kafka', 'kafka-init'],
  );
});

for (const timeout of ['bad', '0', '-1', '3600001']) {
  test(`invalid timeout ${timeout}: no Docker calls`, async () => {
    const result = await probe({}, { timeout });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /invalid RASTA_KAFKA_INIT_TIMEOUT_MS/);
    assert.deepEqual(result.calls, []);
  });
}
test('unrecognised service argument: no Docker calls or argument disclosure', async () => {
  const result = await probe({}, { args: ['untrusted-argument'] });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, []);
  assert.doesNotMatch(result.output, /untrusted-argument/);
});

test('package startup/reset preserve preflight before mutations and gate before ACLs', () => {
  const { scripts } = JSON.parse(read('package.json'));
  for (const name of ['infra:up', 'infra:reset']) {
    const steps = scripts[name].split(' && ');
    assert.equal(steps[0], 'node scripts/infra-preflight.mjs');
    assert.equal(steps.at(-2), 'node scripts/kafka-init-gate.mjs');
    assert.match(steps.at(-1), /scripts\/kafka-acl\.mjs apply/);
    assert.ok(!scripts[name].includes('compose up'));
  }
  assert.match(
    scripts['infra:reset'],
    /preflight\.mjs && docker compose down -v && node scripts\/kafka-init-gate/,
  );
  assert.match(scripts.verify, /pnpm run test:kafka-init-gate/);
  assert.match(scripts.verify, /pnpm run test:broker-default/);
  const workflow = YAML.parse(read('.github/workflows/ci.yml'));
  const quality = workflow.jobs.quality.steps.map((step) => step.run ?? '').join('\n');
  assert.match(quality, /pnpm run test:kafka-init-gate/);
  assert.match(quality, /pnpm run test:broker-default/);
  assert.ok(!read('infrastructure/docker/kafka/ci-up.sh').includes('kafka-init-gate'));
});

test('rotation and full rebuild instructions require the gate; ACLs are conditional on success', () => {
  const rotation = read('docs/runbooks/kafka-credential-rotation.md');
  for (const args of ['kafka-tls kafka kafka-init', 'kafka kafka-init']) {
    assert.ok(rotation.includes(`node scripts/kafka-init-gate.mjs ${args} &&`));
  }
  for (const file of ['docs/runbooks/database-bootstrap.md', 'docs/22-developer-handoff.md']) {
    assert.ok(read(file).includes('pnpm infra:up'), file);
    assert.ok(!/^docker compose up -d$/m.test(read(file)), file);
  }
  // Shell syntax check is independent of Docker and credentials.
  execFileSync('bash', ['-n'], {
    input: 'node scripts/kafka-init-gate.mjs kafka kafka-init &&\npnpm kafka:acl:apply:dev\n',
  });
});
