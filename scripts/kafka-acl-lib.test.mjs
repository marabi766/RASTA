import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { SENTINELS, assertNoSentinel, thrownBy } from './refusal-probes.mjs';
import {
  UNREADABLE_CA_FILE,
  aclKey,
  connectionFor,
  diffAcls,
  fromDescribe,
  passwordVariable,
  toKafkajsAcl,
} from './kafka-acl-lib.mjs';

const { AclOperationTypes, AclPermissionTypes, AclResourceTypes, ResourcePatternTypes } = kafkajs;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const binding = (principal, resourceType, resourceName, operation, patternType = 'LITERAL') => ({
  principal,
  resourceType,
  resourceName,
  patternType,
  operation,
});

test('names every password the way @rasta/config does', () => {
  assert.equal(passwordVariable('fleet-service'), 'KAFKA_SASL_PASSWORD_FLEET');
  assert.equal(passwordVariable('ops-replay'), 'KAFKA_SASL_PASSWORD_OPS_REPLAY');
  assert.equal(passwordVariable('itest-observer'), 'KAFKA_SASL_PASSWORD_ITEST_OBSERVER');
  assert.equal(passwordVariable('admin'), 'KAFKA_SASL_PASSWORD_ADMIN');
});

test('every development principal, and the admin, has its credential where it belongs', () => {
  // Services' own in .env.example (every service loads it); the admin's,
  // ops-replay's and the observer's in the bootstrap-only example; the two
  // tools' as compose's fixed development defaults (review of #131, #1).
  const spec = JSON.parse(read('infrastructure/docker/kafka/broker-acls.development.json'));
  const where = {
    env: read('.env.example'),
    bootstrap: read('infrastructure/docker/kafka/bootstrap.env.example'),
    compose: read('docker-compose.yml'),
  };
  const variables = [spec.admin, ...spec.principals].map(passwordVariable);
  assert.equal(
    new Set(variables).size,
    variables.length,
    'two principals share a password variable',
  );
  for (const principal of [spec.admin, ...spec.principals]) {
    const variable = passwordVariable(principal);
    const home = principal.endsWith('-service')
      ? 'env'
      : ['kafka-ui', 'kafka-exporter'].includes(principal)
        ? 'compose'
        : 'bootstrap';
    const pattern =
      home === 'compose'
        ? new RegExp(`\\$\\{${variable}:-\\S+\\}`)
        : new RegExp(`^${variable}=\\S+$`, 'm');
    assert.match(where[home], pattern, `${variable} is missing from its ${home} file`);
  }
});

for (const profile of ['development', 'deployment']) {
  test(`principals.${profile}.txt lists exactly the generated ${profile} principals`, () => {
    const spec = JSON.parse(read(`infrastructure/docker/kafka/broker-acls.${profile}.json`));
    assert.equal(spec.profile, profile);
    const listed = read(`infrastructure/docker/kafka/principals.${profile}.txt`)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    assert.deepEqual(listed, spec.principals);
    assert.ok(
      !listed.includes(spec.admin),
      'the admin is formatted separately, never from the list',
    );
  });
}

test('the deployment profile has none of the development-only principals', () => {
  const spec = JSON.parse(read('infrastructure/docker/kafka/broker-acls.deployment.json'));
  for (const principal of ['itest-observer', 'kafka-ui', 'kafka-exporter']) {
    assert.ok(!spec.principals.includes(principal), principal);
    assert.ok(!spec.acls.some((acl) => acl.principal === principal), principal);
  }
});

test('connects as the principal over SCRAM-SHA-512 and TLS when both are configured', () => {
  const connection = connectionFor(
    'ops-replay',
    {
      KAFKA_BROKERS: 'a:9092, b:9092',
      KAFKA_SASL_PASSWORD_OPS_REPLAY: 's3cret',
      KAFKA_SSL_CA_FILE: '/tls/ca.pem',
    },
    (path) => `pem from ${path}`,
  );
  assert.deepEqual(connection, {
    clientId: 'rasta-ops-replay',
    brokers: ['a:9092', 'b:9092'],
    sasl: { mechanism: 'scram-sha-512', username: 'ops-replay', password: 's3cret' },
    ssl: { ca: ['pem from /tls/ca.pem'], rejectUnauthorized: true },
  });
});

test('without a password or a CA it is PLAINTEXT, which the authenticated broker refuses', () => {
  const connection = connectionFor('admin', {}, () => assert.fail('no CA to read'));
  assert.deepEqual(connection, { clientId: 'rasta-admin', brokers: ['localhost:9092'] });
});

test('a generated binding becomes an ALLOW from any host', () => {
  assert.deepEqual(
    toKafkajsAcl(binding('fleet-service', 'GROUP', 'fleet-service.', 'READ', 'PREFIXED')),
    {
      resourceType: AclResourceTypes.GROUP,
      resourceName: 'fleet-service.',
      resourcePatternType: ResourcePatternTypes.PREFIXED,
      principal: 'User:fleet-service',
      host: '*',
      operation: AclOperationTypes.READ,
      permissionType: AclPermissionTypes.ALLOW,
    },
  );
});

test('reads the broker back into the generator shape, and round-trips', () => {
  const wanted = [
    binding('asset-service', 'TOPIC', 'rasta.asset.v1', 'WRITE'),
    binding('kafka-ui', 'CLUSTER', 'kafka-cluster', 'DESCRIBE'),
    binding('kafka-ui', 'TOPIC', 'rasta.', 'DESCRIBE', 'PREFIXED'),
  ];
  const resources = wanted.map((entry) => {
    const acl = toKafkajsAcl(entry);
    return {
      resourceType: acl.resourceType,
      resourceName: acl.resourceName,
      resourcePatternType: acl.resourcePatternType,
      acls: [
        {
          principal: acl.principal,
          host: acl.host,
          operation: acl.operation,
          permissionType: acl.permissionType,
        },
      ],
    };
  });
  assert.deepEqual(fromDescribe(resources), wanted);
  assert.deepEqual(diffAcls(wanted, fromDescribe(resources)), { add: [], remove: [] });
});

test('a binding the generator cannot express is marked, so it is pruned rather than ignored', () => {
  const resource = (acl) => ({
    resourceType: AclResourceTypes.TOPIC,
    resourceName: 'rasta.economic.v1',
    resourcePatternType: ResourcePatternTypes.LITERAL,
    acls: [acl],
  });
  const allow = {
    principal: 'User:fleet-service',
    host: '*',
    operation: AclOperationTypes.WRITE,
    permissionType: AclPermissionTypes.ALLOW,
  };
  const odd = [
    resource({ ...allow, permissionType: AclPermissionTypes.DENY }),
    resource({ ...allow, host: '10.0.0.1' }),
    resource({ ...allow, operation: AclOperationTypes.ALL }),
    resource({ ...allow, principal: 'Group:ops' }),
  ];
  for (const entry of odd) {
    const [read] = fromDescribe([entry]);
    assert.equal(read.unexpected, true);
    assert.deepEqual(read.raw.acl, entry.acls[0]);
    assert.deepEqual(diffAcls([], [read]).remove, [read]);
  }
});

test('diff adds what is missing, removes what is extra, keeps what matches', () => {
  const keep = binding('fleet-service', 'TOPIC', 'rasta.fleet.v1', 'WRITE');
  const missing = binding('fleet-service', 'TOPIC', 'rasta.asset.v1', 'READ');
  const stale = binding('fleet-service', 'TOPIC', 'rasta.economic.v1', 'WRITE');
  const { add, remove } = diffAcls([keep, missing], [keep, stale]);
  assert.deepEqual(add, [missing]);
  assert.deepEqual(remove, [stale]);
  assert.notEqual(aclKey(keep), aclKey({ ...keep, patternType: 'PREFIXED' }));
});

test('the applier refuses to run without an explicit profile (review of #131, #5)', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = resolve(ROOT, 'scripts/kafka-acl.mjs');
  for (const args of [['apply'], ['apply', '--profile'], ['apply', '--profile', 'production']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: {} });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /--profile development\|deployment/);
  }
});

// #385 r4: the configured CA path is not repeated — not by the library's error
// in any part (the filesystem's ENOENT carries it on .message and .path), and
// not by the real applier, which refuses before it connects.
const missingCa = (sentinel) => `/nonexistent/${sentinel}/${sentinel.replaceAll('-', '_')}/ca.pem`;

test('connectionFor: an unreadable CA file is one fixed refusal, with nothing of the path', () => {
  for (const sentinel of SENTINELS) {
    const error = thrownBy(() =>
      connectionFor('admin', { KAFKA_SSL_CA_FILE: missingCa(sentinel) }, (path) =>
        readFileSync(path, 'utf8'),
      ),
    );
    assert.equal(error.message, UNREADABLE_CA_FILE);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), []);
    assertNoSentinel(error, sentinel);
  }
});

test('kafka-acl.mjs: an unreadable CA file is refused before connecting, path unprinted', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const script = resolve(ROOT, 'scripts/kafka-acl.mjs');
  const run = (env) =>
    spawnSync(process.execPath, [script, 'apply', '--profile', 'development'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  for (const sentinel of SENTINELS) {
    const result = run({ KAFKA_SSL_CA_FILE: missingCa(sentinel), KAFKA_SASL_PASSWORD_ADMIN: 'x' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `kafka acl: ${UNREADABLE_CA_FILE}\n`);
    assert.equal(result.stdout, '');
    assertNoSentinel(result.stdout + result.stderr, sentinel);
  }
  // Positive control: a readable CA passes the read, and the run goes on to its
  // next check (no admin password here) — still before any connection.
  const dir = mkdtempSync(resolve(tmpdir(), 'kafka-acl-ca-'));
  try {
    writeFileSync(resolve(dir, 'ca.pem'), 'PEM');
    const result = run({ KAFKA_SSL_CA_FILE: resolve(dir, 'ca.pem') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^kafka acl: KAFKA_SASL_PASSWORD_ADMIN is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
