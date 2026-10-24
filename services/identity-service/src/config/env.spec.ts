import { EnvValidationError } from '@rasta/config';
import { loadIdentityEnv, provisioningScopePolicy, roleGrantPolicy } from './env';
import {
  APPROVAL_TRANSACTION_TIMEOUT_MS,
  PROJECTION_TRANSACTION_TIMEOUT_MS,
  identityOperationBudgets,
} from './operation-budgets';
import { APPROVAL_TRANSACTION_OPTIONS } from '../identity/identity.service';
import { PROJECTION_TRANSACTION_OPTIONS } from '../keycloak/keycloak.projector';

/**
 * `KEYCLOAK_SYNC_ENABLED` — whether account provisioning reaches the identity
 * provider or is recorded locally only.
 *
 * It used `z.coerce.boolean()`, so `KEYCLOAK_SYNC_ENABLED=false` parsed as
 * `true` and the service still called Keycloak. The flag exists so unit and
 * API tests can run without an identity provider; a test environment that set
 * it to `false` got connection failures instead, and the configuration looked
 * correct while doing the opposite of what it said (D-020).
 */
const BASE: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_identity?schema=public',
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
  KEYCLOAK_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'rasta',
  KEYCLOAK_BACKEND_CLIENT_ID: 'rasta-backend',
  KEYCLOAK_BACKEND_CLIENT_SECRET: 'a-backend-client-secret',
  AUDIT_SERVICE_URL: 'http://localhost:3115',
};

// NODE_ENV=test: `false` is honoured only where it is named explicitly (D-064).
const load = (value?: string) =>
  loadIdentityEnv({
    ...BASE,
    NODE_ENV: 'test',
    ...(value === undefined ? {} : { KEYCLOAK_SYNC_ENABLED: value }),
  });

describe('KEYCLOAK_SYNC_ENABLED', () => {
  it('defaults to true — a deployed environment provisions real accounts', () => {
    expect(load().KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it('reads "true" as true', () => {
    expect(load('true').KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it('reads "false" as false — the local-only mode is reachable again', () => {
    expect(load('false').KEYCLOAK_SYNC_ENABLED).toBe(false);
  });

  it.each(['FALSE', '0', 'no', 'off', ' false '])('reads %p as false', (value) => {
    expect(load(value).KEYCLOAK_SYNC_ENABLED).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %p as true', (value) => {
    expect(load(value).KEYCLOAK_SYNC_ENABLED).toBe(true);
  });

  it.each(['maybe', 'sync', '2'])('refuses %p rather than guessing', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});

/**
 * D-064 — the two switches that would let a narrowing change commit without
 * reaching Keycloak are honoured only with NODE_ENV named as development or
 * test; an unset NODE_ENV, which the schema defaults to development, does not
 * count.
 */
describe('narrowing cannot be switched off outside development and test (D-064)', () => {
  const at = (nodeEnv: string | undefined, values: NodeJS.ProcessEnv) =>
    loadIdentityEnv({
      ...BASE,
      ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      ...values,
    });

  it.each([
    ['KEYCLOAK_SYNC_ENABLED', { KEYCLOAK_SYNC_ENABLED: 'false' }],
    ['MEMBERSHIP_EXPIRY_SCAN_ENABLED', { MEMBERSHIP_EXPIRY_SCAN_ENABLED: 'false' }],
  ])('%s=false is refused in production, staging and with NODE_ENV unset', (name, values) => {
    for (const nodeEnv of ['production', 'staging', undefined]) {
      expect(() => at(nodeEnv, values)).toThrow(EnvValidationError);
      expect(() => at(nodeEnv, values)).toThrow(new RegExp(`${name}: may be false only`));
    }
  });

  it.each(['development', 'test'])('both may be false with NODE_ENV=%s', (nodeEnv) => {
    expect(
      at(nodeEnv, { KEYCLOAK_SYNC_ENABLED: 'false', MEMBERSHIP_EXPIRY_SCAN_ENABLED: 'false' }),
    ).toMatchObject({ KEYCLOAK_SYNC_ENABLED: false, MEMBERSHIP_EXPIRY_SCAN_ENABLED: false });
  });

  it('both on is accepted everywhere', () => {
    expect(at('production', {})).toMatchObject({
      KEYCLOAK_SYNC_ENABLED: true,
      MEMBERSHIP_EXPIRY_SCAN_ENABLED: true,
    });
  });

  it('KEYCLOAK_WRITE_SETTLE_SECONDS defaults to 120, above the 10 s client deadline, and is bounded', () => {
    expect(at('production', {}).KEYCLOAK_WRITE_SETTLE_SECONDS).toBe(120);
    expect(
      at('production', { KEYCLOAK_WRITE_SETTLE_SECONDS: '15' }).KEYCLOAK_WRITE_SETTLE_SECONDS,
    ).toBe(15);
    expect(
      at('production', { KEYCLOAK_WRITE_SETTLE_SECONDS: '900' }).KEYCLOAK_WRITE_SETTLE_SECONDS,
    ).toBe(900);
    for (const value of ['14', '901', '1.5', '-1', 'soon']) {
      expect(() => at('production', { KEYCLOAK_WRITE_SETTLE_SECONDS: value })).toThrow(
        EnvValidationError,
      );
    }
  });
});

/**
 * ADR-053 § 4 — the refusal-audit bounds. The capture timeout is the longest a
 * `403` can wait on its own evidence, so both ends of its range are policy.
 */
describe('refusal audit configuration', () => {
  const withEnv = (overrides: NodeJS.ProcessEnv) => loadIdentityEnv({ ...BASE, ...overrides });

  it('defaults to a short capture bound and a one-second flush', () => {
    const env = withEnv({});
    expect(env.SECURITY_EVENT_CAPTURE_TIMEOUT_MS).toBe(250);
    expect(env.SECURITY_EVENT_FLUSH_INTERVAL_MS).toBe(1000);
    expect(env.SECURITY_EVENT_FLUSH_BATCH_SIZE).toBe(100);
  });

  it('aggregates refusals over the one-minute window ADR-053 § 4 describes by default', () => {
    expect(withEnv({}).SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS).toBe(60);
  });

  it.each([
    ['1', 1],
    ['10', 10],
    ['3600', 3600],
  ])('accepts an aggregation window of %p seconds', (value, expected) => {
    expect(
      withEnv({ SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS: value })
        .SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS,
    ).toBe(expected);
  });

  it.each(['0', '-60', '3601', '1.5', 'minute'])(
    'refuses an aggregation window of %p rather than disabling or stretching aggregation',
    (value) => {
      expect(() => withEnv({ SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS: value })).toThrow(
        EnvValidationError,
      );
    },
  );

  it.each(['9', '5001', 'abc', '1.5'])('refuses a capture timeout of %p', (value) => {
    expect(() => withEnv({ SECURITY_EVENT_CAPTURE_TIMEOUT_MS: value })).toThrow(EnvValidationError);
  });

  it.each([
    ['SECURITY_EVENT_FLUSH_INTERVAL_MS', '49'],
    ['SECURITY_EVENT_FLUSH_INTERVAL_MS', '60001'],
    ['SECURITY_EVENT_FLUSH_BATCH_SIZE', '0'],
    ['SECURITY_EVENT_FLUSH_BATCH_SIZE', '1001'],
  ])('refuses %s=%p', (key, value) => {
    expect(() => withEnv({ [key]: value })).toThrow(EnvValidationError);
  });
});

describe('audit correction lookup configuration (AUD-003 correction)', () => {
  it('requires the audit-service URL, with no guessed default', () => {
    const { AUDIT_SERVICE_URL: _omitted, ...withoutUrl } = BASE;
    expect(() => loadIdentityEnv(withoutUrl)).toThrow();
  });

  it('refuses a value that is not a URL', () => {
    expect(() => loadIdentityEnv({ ...BASE, AUDIT_SERVICE_URL: 'audit-service' })).toThrow();
  });

  it('bounds the lookup with a finite default timeout', () => {
    expect(loadIdentityEnv(BASE).AUDIT_REQUEST_TIMEOUT_MS).toBe(3000);
    expect(() => loadIdentityEnv({ ...BASE, AUDIT_REQUEST_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadIdentityEnv({ ...BASE, AUDIT_REQUEST_TIMEOUT_MS: '60000' })).toThrow();
  });
});

describe('the role-grant ladder (docs/24 Q-60)', () => {
  it('defaults to the narrow reading of the docs/09 scope column', () => {
    const env = loadIdentityEnv(BASE);
    expect(env.ROLE_GRANTS_BY_ORGANIZATION_ADMIN).toEqual([
      'ORGANIZATION_ADMIN',
      'FLEET_MANAGER',
      'DRIVER',
      'OPERATOR',
      'PROCUREMENT_USER',
    ]);
    expect(env.ROLE_GRANTS_BY_UNION_ADMIN).toContain('UNION_ADMIN');
    expect(env.ROLE_GRANTS_BY_SYSTEM_ADMIN).not.toContain('SYSTEM_ADMIN');
  });

  it('assembles the three lists into the policy the service holds', () => {
    const policy = roleGrantPolicy(loadIdentityEnv(BASE));
    expect(policy.byOrganizationAdmin).toContain('FLEET_MANAGER');
    expect(policy.byUnionAdmin).toContain('ORGANIZATION_ADMIN');
  });

  it('reads a narrowed list', () => {
    const env = loadIdentityEnv({
      ...BASE,
      ROLE_GRANTS_BY_ORGANIZATION_ADMIN: 'DRIVER, OPERATOR',
    });
    expect(env.ROLE_GRANTS_BY_ORGANIZATION_ADMIN).toEqual(['DRIVER', 'OPERATOR']);
  });

  it('accepts an empty list as "grants nothing", which is a real answer', () => {
    const env = loadIdentityEnv({ ...BASE, ROLE_GRANTS_BY_ORGANIZATION_ADMIN: '' });
    expect(env.ROLE_GRANTS_BY_ORGANIZATION_ADMIN).toEqual([]);
  });

  it('drops a repeated entry rather than counting it twice', () => {
    const env = loadIdentityEnv({
      ...BASE,
      ROLE_GRANTS_BY_ORGANIZATION_ADMIN: 'DRIVER,DRIVER,OPERATOR',
    });
    expect(env.ROLE_GRANTS_BY_ORGANIZATION_ADMIN).toEqual(['DRIVER', 'OPERATOR']);
  });

  it('fails the deployment on a misspelled role rather than silently granting nothing', () => {
    expect(() =>
      loadIdentityEnv({ ...BASE, ROLE_GRANTS_BY_ORGANIZATION_ADMIN: 'FLEET_MANGER' }),
    ).toThrow(EnvValidationError);
  });

  it.each([
    'ROLE_GRANTS_BY_SYSTEM_ADMIN',
    'ROLE_GRANTS_BY_UNION_ADMIN',
    'ROLE_GRANTS_BY_ORGANIZATION_ADMIN',
  ])('refuses SYSTEM_ADMIN configured as grantable in %s', (key) => {
    // The service would refuse it anyway — `grantableRoles` intersects it out.
    // Refusing the value as well is what stops an operator believing they
    // configured something they did not get.
    expect(() => loadIdentityEnv({ ...BASE, [key]: 'SYSTEM_ADMIN' })).toThrow(EnvValidationError);
  });
});

describe('cross-organization provisioning (docs/24 Q-61)', () => {
  it('defaults to the platform operator alone', () => {
    expect(loadIdentityEnv(BASE).USER_PROVISIONING_CROSS_ORG_ROLES).toEqual(['SYSTEM_ADMIN']);
  });

  it('assembles the policy the service holds', () => {
    expect(provisioningScopePolicy(loadIdentityEnv(BASE)).crossOrgRoles).toEqual(['SYSTEM_ADMIN']);
  });

  it('permits SYSTEM_ADMIN here, unlike the grant ladder', () => {
    // The ladder refuses it because nobody may be *granted* it. This variable
    // asks a different question — whose organization may you act in — and the
    // platform operator is exactly who may act in anyone's.
    expect(() =>
      loadIdentityEnv({ ...BASE, USER_PROVISIONING_CROSS_ORG_ROLES: 'SYSTEM_ADMIN' }),
    ).not.toThrow();
  });

  it('widens to UNION_ADMIN when a deployment answers Q-61 that way', () => {
    const env = loadIdentityEnv({
      ...BASE,
      USER_PROVISIONING_CROSS_ORG_ROLES: 'SYSTEM_ADMIN,UNION_ADMIN',
    });
    expect(env.USER_PROVISIONING_CROSS_ORG_ROLES).toEqual(['SYSTEM_ADMIN', 'UNION_ADMIN']);
  });

  it('accepts an empty list — nobody provisions outside their own organization', () => {
    const env = loadIdentityEnv({ ...BASE, USER_PROVISIONING_CROSS_ORG_ROLES: '' });
    expect(env.USER_PROVISIONING_CROSS_ORG_ROLES).toEqual([]);
  });

  it('fails the deployment on a misspelled role', () => {
    expect(() =>
      loadIdentityEnv({ ...BASE, USER_PROVISIONING_CROSS_ORG_ROLES: 'UNIONADMIN' }),
    ).toThrow(EnvValidationError);
  });
});

/**
 * #268 r4: DATABASE_STATEMENT_TIMEOUT_MS is opt-in, and when set it must be
 * above every operation budget — the Keycloak projection and the registration
 * approval, 65 s, are the longest.
 */
describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets', () => {
  const at = (statementTimeoutMs: string) => () =>
    loadIdentityEnv({ ...BASE, DATABASE_STATEMENT_TIMEOUT_MS: statementTimeoutMs });

  it('unset, applies no statement timeout', () => {
    const env = loadIdentityEnv(BASE);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(
      identityOperationBudgets(loadIdentityEnv(BASE)).map((b) => [b.name, b.budgetMs]),
    ).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['PROJECTION_TRANSACTION_TIMEOUT_MS', 65_000],
      ['APPROVAL_TRANSACTION_TIMEOUT_MS', 65_000],
      ['SECURITY_EVENT_CAPTURE_TIMEOUT_MS', 250],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
    ]);
  });

  it('the Keycloak transactions keep their own SET LOCAL at exactly their budgets', () => {
    expect(PROJECTION_TRANSACTION_OPTIONS).toMatchObject({
      timeout: PROJECTION_TRANSACTION_TIMEOUT_MS,
      statementTimeoutMs: PROJECTION_TRANSACTION_TIMEOUT_MS,
    });
    expect(APPROVAL_TRANSACTION_OPTIONS).toMatchObject({
      timeout: APPROVAL_TRANSACTION_TIMEOUT_MS,
      statementTimeoutMs: APPROVAL_TRANSACTION_TIMEOUT_MS,
    });
  });

  it('set, must be above the largest: the Keycloak transactions, 65 s; the bound is exact', () => {
    expect(at('65000')).toThrow(/not above PROJECTION_TRANSACTION_TIMEOUT_MS, 65000 ms/);
    expect(at('65000')).toThrow(/not above APPROVAL_TRANSACTION_TIMEOUT_MS, 65000 ms/);
    expect(at('65001')).not.toThrow();
  });
});
