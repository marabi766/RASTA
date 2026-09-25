import { loadOrganizationEnv } from './env';

/**
 * `GOVERNANCE_POLICY_SETTER_ROLES` — who may set governance policy (Q-64).
 *
 * A typo here must stop the service rather than quietly admit nobody, or
 * admit a role nobody meant.
 */
const base = {
  NODE_ENV: 'test',
  DATABASE_URL_ORGANIZATION: 'postgresql://u:p@127.0.0.1:5433/db',
  KAFKA_BROKERS: '127.0.0.1:9092',
  OIDC_ISSUER_URL: 'http://127.0.0.1:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://127.0.0.1:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  // Obviously fake on purpose (docs/26 § 26.6): a realistic value trips Gitleaks.
  INTERNAL_TOKEN_SECRET: 'not-a-secret-placeholder-for-env-parsing-only',
};

describe('GOVERNANCE_POLICY_SETTER_ROLES', () => {
  it('defaults to the provisional decision: SYSTEM_ADMIN and UNION_ADMIN', () => {
    expect(loadOrganizationEnv({ ...base }).GOVERNANCE_POLICY_SETTER_ROLES).toEqual([
      'SYSTEM_ADMIN',
      'UNION_ADMIN',
    ]);
  });

  it('reads a configured list, trimming whitespace', () => {
    expect(
      loadOrganizationEnv({ ...base, GOVERNANCE_POLICY_SETTER_ROLES: ' SYSTEM_ADMIN , ' })
        .GOVERNANCE_POLICY_SETTER_ROLES,
    ).toEqual(['SYSTEM_ADMIN']);
  });

  it('refuses a role the platform does not grant', () => {
    expect(() =>
      loadOrganizationEnv({ ...base, GOVERNANCE_POLICY_SETTER_ROLES: 'SYSTEM_ADMIN,UNION_ADMN' }),
    ).toThrow();
  });

  it('refuses an empty list rather than silently admitting nobody', () => {
    expect(() => loadOrganizationEnv({ ...base, GOVERNANCE_POLICY_SETTER_ROLES: ' , ' })).toThrow();
  });
});
