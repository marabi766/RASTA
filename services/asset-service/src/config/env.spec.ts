import { assetEnvSchema, loadAssetEnv } from './env';
import { assetOperationBudgets } from './operation-budgets';

/**
 * #268 r4: DATABASE_STATEMENT_TIMEOUT_MS is opt-in, and when set it must be
 * above every operation budget the service declares — the longest is a
 * replayed timeline event's refresh, which holds the asset row across one
 * work-state exchange while every other delivery or write for that asset waits.
 */
describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets', () => {
  const BASE: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_asset?schema=public',
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
    FLEET_SERVICE_URL: 'http://localhost:3104',
    MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
    DOCUMENT_SERVICE_URL: 'http://localhost:3107',
  };
  const load = (overrides: NodeJS.ProcessEnv) => () => loadAssetEnv({ ...BASE, ...overrides });

  it('unset, applies no statement timeout', () => {
    const env = loadAssetEnv(BASE);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(assetOperationBudgets(loadAssetEnv(BASE)).map((b) => [b.name, b.budgetMs])).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['IN_FLIGHT_WAIT_MS', 7000],
      ['REFRESH_TRANSACTION_TIMEOUT_MS', 30_000],
      ['ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS', 8000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
      ['OUTBOX_PURGE_STATEMENT_TIMEOUT_MS', 10_000],
    ]);
  });

  it('set, must be above the largest: the replay refresh, 30 s; the bound is exact', () => {
    expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '30000' })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(30000 ms\) is not above REFRESH_TRANSACTION_TIMEOUT_MS, 30000 ms/,
    );
    expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '30001' })).not.toThrow();
    expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '7000' })).toThrow(/not above IN_FLIGHT_WAIT_MS/);
  });

  it('a configured budget raises the floor: the clearance timeout + 5 s', () => {
    const slow = { ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS: '30000' };
    expect(load({ ...slow, DATABASE_STATEMENT_TIMEOUT_MS: '35000' })).toThrow(
      /not above ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS, 35000 ms/,
    );
    expect(load({ ...slow, DATABASE_STATEMENT_TIMEOUT_MS: '35001' })).not.toThrow();
  });
});

/**
 * The two claim-authority settings (docs/24 Q-59), parsed as a deployment
 * would set them. Tested on the schema fields directly: what matters is the
 * shape each string becomes, not the rest of the environment.
 */
describe('claim authority configuration', () => {
  const roles = assetEnvSchema.shape.INSURANCE_CLAIM_DECISION_ROLES;
  const ceiling = assetEnvSchema.shape.INSURANCE_CLAIM_APPROVAL_CEILING_MINOR;

  it('defaults the deciding roles to the organization’s own administrators', () => {
    expect(roles.parse(undefined)).toEqual(['ORGANIZATION_ADMIN', 'UNION_ADMIN']);
  });

  it('splits and trims a configured list', () => {
    expect(roles.parse(' UNION_ADMIN, FLEET_MANAGER ')).toEqual(['UNION_ADMIN', 'FLEET_MANAGER']);
  });

  it('refuses an empty element rather than treating it as a role nobody holds', () => {
    // `a,,b` would otherwise parse to a role named "" — never granted, never
    // noticed. A refusal at boot is the honest outcome.
    expect(() => roles.parse('ORGANIZATION_ADMIN,,UNION_ADMIN')).toThrow();
    expect(() => roles.parse('')).toThrow();
  });

  it('defaults the ceiling to none', () => {
    expect(ceiling.parse(undefined)).toBeNull();
    expect(ceiling.parse('')).toBeNull();
  });

  it('parses the ceiling as a bigint in minor units', () => {
    expect(ceiling.parse('5000000000000')).toBe(5_000_000_000_000n);
  });

  it('refuses a ceiling that is not a plain non-negative integer', () => {
    expect(() => ceiling.parse('12.5')).toThrow();
    expect(() => ceiling.parse('-1')).toThrow();
    expect(() => ceiling.parse('1e9')).toThrow();
  });
});

/** The claim attachment policy (docs/24 Q-128), validated at boot. */
describe('claim attachment policy configuration', () => {
  const max = assetEnvSchema.shape.INSURANCE_CLAIM_MAX_DOCUMENTS;
  const statuses = assetEnvSchema.shape.INSURANCE_CLAIM_DOCUMENT_STATUSES;

  it('defaults to twenty documents, while the claim is open', () => {
    expect(max.parse(undefined)).toBe(20);
    expect(statuses.parse(undefined)).toEqual(['SUBMITTED', 'UNDER_REVIEW']);
  });

  it('takes a configured limit and a trimmed status list', () => {
    expect(max.parse('50')).toBe(50);
    expect(statuses.parse(' SUBMITTED, UNDER_REVIEW ,APPROVED')).toEqual([
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
    ]);
  });

  it('refuses a limit that is not an integer from 1 to 200', () => {
    for (const bad of ['0', '-1', '201', '2.5', 'many']) {
      expect(() => max.parse(bad)).toThrow();
    }
  });

  it('refuses an unknown, repeated, blank or empty status list', () => {
    for (const bad of ['', 'SUBMITTED,,UNDER_REVIEW', 'OPEN', 'SUBMITTED,SUBMITTED', 'submitted']) {
      expect(() => statuses.parse(bad)).toThrow();
    }
  });

  it('stops the service at start-up on an invalid value', () => {
    const base: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_asset?schema=public',
      KAFKA_BROKERS: 'localhost:9092',
      OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
      OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
      OIDC_AUDIENCE: 'rasta-api',
      INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
      FLEET_SERVICE_URL: 'http://localhost:3104',
      MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
      DOCUMENT_SERVICE_URL: 'http://localhost:3107',
    };
    expect(() => loadAssetEnv({ ...base, INSURANCE_CLAIM_MAX_DOCUMENTS: '0' })).toThrow();
    expect(() => loadAssetEnv({ ...base, INSURANCE_CLAIM_DOCUMENT_STATUSES: 'NOPE' })).toThrow();
    expect(loadAssetEnv(base).INSURANCE_CLAIM_MAX_DOCUMENTS).toBe(20);
  });
});

/** The two Idempotency-Key lifetimes on POST /v1/assets (#169), validated at boot. */
describe('idempotency configuration', () => {
  const ttl = assetEnvSchema.shape.ASSET_IDEMPOTENCY_TTL_HOURS;
  const lease = assetEnvSchema.shape.ASSET_IDEMPOTENCY_CLAIM_LEASE_SECONDS;

  it('keeps a completed response for a day and an in-flight claim for two minutes by default', () => {
    expect(ttl.parse(undefined)).toBe(24);
    expect(lease.parse(undefined)).toBe(120);
  });

  it('refuses a lease below the floor that keeps a slow request its claim, or above an hour', () => {
    expect(lease.parse('30')).toBe(30);
    expect(() => lease.parse('29')).toThrow();
    expect(() => lease.parse('3601')).toThrow();
    expect(() => lease.parse('90.5')).toThrow();
  });

  it('refuses a response lifetime outside one hour to a week', () => {
    expect(() => ttl.parse('0')).toThrow();
    expect(() => ttl.parse('169')).toThrow();
  });
});
