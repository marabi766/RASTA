import { loadMaxHierarchyDepth, loadOrganizationEnv } from './env';
import { organizationOperationBudgets } from './operation-budgets';

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

describe('MAX_HIERARCHY_DEPTH for the demo seed (Codex r1 on #295)', () => {
  it('is the value the service runs with: default, configured, and refused alike', () => {
    expect(loadMaxHierarchyDepth({})).toBe(8);
    expect(loadMaxHierarchyDepth({})).toBe(loadOrganizationEnv({ ...base }).MAX_HIERARCHY_DEPTH);
    expect(loadMaxHierarchyDepth({ MAX_HIERARCHY_DEPTH: '3' })).toBe(3);
    expect(loadOrganizationEnv({ ...base, MAX_HIERARCHY_DEPTH: '3' }).MAX_HIERARCHY_DEPTH).toBe(3);
    for (const invalid of ['0', '21', '2.5', 'deep']) {
      expect(() => loadMaxHierarchyDepth({ MAX_HIERARCHY_DEPTH: invalid })).toThrow(
        /MAX_HIERARCHY_DEPTH/,
      );
      expect(() => loadOrganizationEnv({ ...base, MAX_HIERARCHY_DEPTH: invalid })).toThrow(
        /MAX_HIERARCHY_DEPTH/,
      );
    }
  });
});

describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets (#268 r4)', () => {
  const at = (statementTimeoutMs: string) => () =>
    loadOrganizationEnv({ ...base, DATABASE_STATEMENT_TIMEOUT_MS: statementTimeoutMs });

  it('unset, applies no statement timeout', () => {
    const env = loadOrganizationEnv({ ...base });
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(
      organizationOperationBudgets(loadOrganizationEnv({ ...base })).map((b) => [
        b.name,
        b.budgetMs,
      ]),
    ).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
      ['OUTBOX_PURGE_STATEMENT_TIMEOUT_MS', 10_000],
    ]);
  });

  it('set, must be above the largest: the outbox renewal; the bound is exact', () => {
    expect(at('5000')).toThrow(/not above PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS, 5000 ms/);
    expect(at('12500')).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(12500 ms\) is not above OUTBOX_CLAIM_LEASE_SECONDS, 12500 ms/,
    );
    expect(at('12501')).not.toThrow();
  });
});
