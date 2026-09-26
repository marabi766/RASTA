import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DISPOSABLE_REALM_ATTRIBUTE,
  E2eTargetRefusedError,
  assertDisposableE2eTarget,
  disposableRealmRefusal,
  e2eTargetRefusals,
  isLoopbackHost,
} from './target-guard.ts';

/**
 * The suite's fail-closed gate (Codex post-merge review of #105, finding 2).
 * Runs under `node --test` without a stack: the gate is pure, and a gate that
 * needed the stack to be tested would have to reach it first.
 */

const LOCAL = {
  gatewayUrl: 'http://localhost:3000',
  economicUrl: 'http://localhost:3112',
  marketplaceUrl: 'http://127.0.0.1:3106',
  documentUrl: 'http://localhost:3114',
  auditUrl: 'http://localhost:3115',
  identityUrl: 'http://[::1]:3101',
  constructionUrl: 'http://localhost:3110',
  keycloakUrl: 'http://localhost:8080',
  kafkaBrokers: ['localhost:9092', '127.0.0.1:9093'],
};
const ALLOWED_ENV = { NODE_ENV: 'test', E2E_ALLOW_WRITES: 'true' };

describe('assertDisposableE2eTarget', () => {
  it('lets a loopback stack through with the test environment and the opt-in', () => {
    assert.doesNotThrow(() => assertDisposableE2eTarget(LOCAL, ALLOWED_ENV));
  });

  for (const [label, env] of [
    ['an unset NODE_ENV', { E2E_ALLOW_WRITES: 'true' }],
    ['NODE_ENV=development', { ...ALLOWED_ENV, NODE_ENV: 'development' }],
    ['NODE_ENV=production', { ...ALLOWED_ENV, NODE_ENV: 'production' }],
    ['no opt-in', { NODE_ENV: 'test' }],
    ['an opt-in of "1"', { ...ALLOWED_ENV, E2E_ALLOW_WRITES: '1' }],
    [
      'the demo seeds’ opt-in instead of its own',
      { NODE_ENV: 'test', RASTA_ALLOW_DEMO_SEED: 'true' },
    ],
  ] as const) {
    it(`refuses ${label}, even against a loopback stack`, () => {
      assert.throws(() => assertDisposableE2eTarget(LOCAL, env), E2eTargetRefusedError);
    });
  }

  for (const [field, setting] of [
    ['gatewayUrl', 'E2E_GATEWAY_URL'],
    ['economicUrl', 'E2E_ECONOMIC_URL'],
    ['marketplaceUrl', 'E2E_MARKETPLACE_URL'],
    ['documentUrl', 'E2E_DOCUMENT_URL'],
    ['auditUrl', 'E2E_AUDIT_URL'],
    ['identityUrl', 'E2E_IDENTITY_URL'],
    ['constructionUrl', 'E2E_CONSTRUCTION_URL'],
    ['keycloakUrl', 'KEYCLOAK_URL'],
  ] as const) {
    it(`refuses a remote ${setting}, naming the setting but not the host`, () => {
      const endpoints = { ...LOCAL, [field]: 'https://sso.prod.example.ir' };

      assert.deepEqual(e2eTargetRefusals(endpoints, ALLOWED_ENV), [
        `${setting} is not a loopback address`,
      ]);
      assert.throws(
        () => assertDisposableE2eTarget(endpoints, ALLOWED_ENV),
        (error: Error) => !error.message.includes('prod.example.ir'),
      );
    });
  }

  it('refuses a remote Kafka broker, even beside a local one', () => {
    const endpoints = { ...LOCAL, kafkaBrokers: ['localhost:9092', 'kafka.prod.internal:9092'] };

    assert.deepEqual(e2eTargetRefusals(endpoints, ALLOWED_ENV), [
      'KAFKA_BROKERS names a broker that is not a loopback address',
    ]);
  });

  it('refuses an empty broker list', () => {
    assert.deepEqual(e2eTargetRefusals({ ...LOCAL, kafkaBrokers: [] }, ALLOWED_ENV), [
      'KAFKA_BROKERS names no broker',
    ]);
  });

  it('refuses a URL that is not http(s)', () => {
    assert.deepEqual(e2eTargetRefusals({ ...LOCAL, gatewayUrl: 'not a url' }, ALLOWED_ENV), [
      'E2E_GATEWAY_URL is not an http(s) URL',
    ]);
    assert.deepEqual(
      e2eTargetRefusals({ ...LOCAL, keycloakUrl: 'file:///etc/passwd' }, ALLOWED_ENV),
      ['KEYCLOAK_URL is not an http(s) URL'],
    );
  });

  it('names every failed condition, not only the first', () => {
    assert.deepEqual(e2eTargetRefusals({ ...LOCAL, keycloakUrl: 'https://sso.example.ir' }, {}), [
      'NODE_ENV is not "test"',
      'E2E_ALLOW_WRITES is not "true"',
      'KEYCLOAK_URL is not a loopback address',
    ]);
  });

  it('reads process.env by default', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.E2E_ALLOW_WRITES = 'true';
      assert.throws(() => assertDisposableE2eTarget(LOCAL), E2eTargetRefusedError);
    } finally {
      process.env = saved;
    }
  });
});

describe('isLoopbackHost', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
    it(`accepts ${host}`, () => assert.equal(isLoopbackHost(host), true));
  }

  for (const host of [
    'localhost.example.ir',
    'evil-localhost',
    '128.0.0.1',
    '10.0.0.1',
    '127.0.0.256',
    '127.0.0',
    '0.0.0.0',
    '::',
    'keycloak',
    '',
  ]) {
    it(`refuses ${JSON.stringify(host)}`, () => assert.equal(isLoopbackHost(host), false));
  }

  it('judges the host a URL actually resolves to, not the text before an @', () => {
    assert.deepEqual(
      e2eTargetRefusals({ ...LOCAL, gatewayUrl: 'http://localhost@gateway.prod.ir' }, ALLOWED_ENV),
      ['E2E_GATEWAY_URL is not a loopback address'],
    );
  });
});

describe('disposableRealmRefusal (Codex review of #117, finding 2)', () => {
  const marked = { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: 'true' } };

  it('accepts the development realm, which carries the marker', () => {
    assert.equal(disposableRealmRefusal(marked, 'rasta'), null);
  });

  for (const [label, representation] of [
    ['a realm with no attributes', { realm: 'rasta' }],
    ['a realm with other attributes only', { realm: 'rasta', attributes: { frontendUrl: 'x' } }],
    [
      'a marker of "false"',
      { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: 'false' } },
    ],
    [
      'a marker of boolean true',
      { realm: 'rasta', attributes: { [DISPOSABLE_REALM_ATTRIBUTE]: true } },
    ],
    ['another realm, even marked', { ...marked, realm: 'master' }],
    ['no representation', null],
    ['a string', 'rasta'],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.notEqual(disposableRealmRefusal(representation, 'rasta'), null);
    });
  }
});

describe('globalSetup checks everything before it writes (Codex review of #117, finding 3)', () => {
  // From the package (`pnpm --filter @rasta/e2e test:unit`) or the repository root.
  const path = ['global-setup.ts', 'tests/e2e/global-setup.ts'].find((candidate) =>
    existsSync(candidate),
  );
  assert.ok(path, 'global-setup.ts not found from the working directory');
  const source = readFileSync(path, 'utf8');
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, `global-setup.ts no longer contains ${needle}`);
    return index;
  };

  it('runs the target gate first, and every check before the first write or token', () => {
    const gate = at('assertDisposableE2eTarget(config)');
    const checks = [
      'economic-service to be ready',
      'marketplace-service to be ready',
      'api-gateway to answer 401',
      'document-service to be ready',
      'audit-service to be ready',
      'identity-service to be ready',
      'construction-service to be ready',
      'Keycloak realm ${config.realm} to be reachable',
      'await verifyDisposableRealm(config)',
      'admin.describeCluster()',
      'config.economicTopic,',
      'config.marketplaceTopic,',
      'config.documentTopic,',
      'config.constructionTopic,',
    ].map(at);
    const firstWrite = Math.min(at('await ensureTenantBUser(config)'), at('await accessToken('));

    assert.ok(
      checks.every((check) => check > gate),
      'a check runs before the target gate',
    );
    assert.ok(
      checks.every((check) => check < firstWrite),
      'a write or a token request runs before a check',
    );
    assert.equal(source.indexOf('ensureTenantBUser('), source.lastIndexOf('ensureTenantBUser('));
  });
});
