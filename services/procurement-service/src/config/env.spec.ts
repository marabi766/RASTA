import { MAX_QUANTITY } from '../demand/dto';
import { corsOrigins, loadProcurementEnv } from './env';
import { procurementOperationBudgets } from './operation-budgets';

const base: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  // Built, not written: a literal that looks like a credential is one to a secret scanner.
  INTERNAL_TOKEN_SECRET: ['only', 'this', 'spec', 'reads', 'it'].join('-').padEnd(40, '-'),
  DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_procurement?schema=public',
};

const load = (overrides: NodeJS.ProcessEnv = {}) => loadProcurementEnv({ ...base, ...overrides });

describe('the provisional defaults (Q-10, Q-119, ADR-070 § 2)', () => {
  const env = load();

  it('lets the buyer’s PROCUREMENT_USER and ORGANIZATION_ADMIN register and read demands', () => {
    expect(env.PROCUREMENT_DEMAND_ROLES).toEqual(['PROCUREMENT_USER', 'ORGANIZATION_ADMIN']);
  });

  it('opens a window for seven days, with no threshold, carried into the next window when short (Q-10)', () => {
    expect(env.PROCUREMENT_AGGREGATION_WINDOW_HOURS).toBe(168);
    expect(env.PROCUREMENT_AGGREGATION_MIN_QUANTITY).toBe(0);
    expect(env.PROCUREMENT_AGGREGATION_SHORTFALL_POLICY).toBe('EXTEND');
  });

  it('replays a command’s response for a day and leases an in-flight key for two minutes', () => {
    expect(env.PROCUREMENT_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(env.PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(120);
  });

  it('names itself, and listens on 3107', () => {
    expect(env.SERVICE_NAME).toBe('procurement-service');
    expect(env.PORT).toBe(3107);
    expect(env.KAFKA_CLIENT_ID).toBe('procurement-service');
  });

  it('has no setting that names an amount, an approver or a supplier', () => {
    expect(Object.keys(env).filter((name) => /AMOUNT|APPROV|SUPPLIER|PRICE/.test(name))).toEqual(
      [],
    );
  });
});

describe('overrides', () => {
  it('takes the port from PORT_PROCUREMENT and the database from DATABASE_URL_PROCUREMENT', () => {
    const env = loadProcurementEnv({
      ...base,
      DATABASE_URL: undefined,
      DATABASE_URL_PROCUREMENT: 'postgresql://u:p@db:5433/rasta_procurement?schema=public',
      PORT_PROCUREMENT: '4107',
    });
    expect(env.PORT).toBe(4107);
    expect(env.DATABASE_URL).toContain('@db:5433/rasta_procurement');
  });

  it('does not fall back to another service’s database variable', () => {
    expect(() =>
      loadProcurementEnv({
        ...base,
        DATABASE_URL: undefined,
        DATABASE_URL_CONTRACT: 'postgresql://u:p@db:5433/rasta_contract',
      }),
    ).toThrow();
  });

  it('accepts a configured role list, window, threshold and each shortfall policy', () => {
    const env = load({
      PROCUREMENT_DEMAND_ROLES: ' ORGANIZATION_ADMIN ',
      PROCUREMENT_AGGREGATION_WINDOW_HOURS: '24',
      PROCUREMENT_AGGREGATION_MIN_QUANTITY: '100',
      PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'REFER',
    });
    expect(env.PROCUREMENT_DEMAND_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.PROCUREMENT_AGGREGATION_WINDOW_HOURS).toBe(24);
    expect(env.PROCUREMENT_AGGREGATION_MIN_QUANTITY).toBe(100);
    expect(env.PROCUREMENT_AGGREGATION_SHORTFALL_POLICY).toBe('REFER');
    expect(load({ PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'CLOSE' })).toMatchObject({
      PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'CLOSE',
    });
  });

  it('accepts a threshold of exactly MAX_QUANTITY, the most a window can hold (PR-300 r2 R2-1)', () => {
    expect(
      load({ PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(MAX_QUANTITY) })
        .PROCUREMENT_AGGREGATION_MIN_QUANTITY,
    ).toBe(MAX_QUANTITY);
  });

  it.each([
    ['AUDITOR among the demand roles', { PROCUREMENT_DEMAND_ROLES: 'PROCUREMENT_USER,AUDITOR' }],
    ['SYSTEM_ADMIN among the demand roles', { PROCUREMENT_DEMAND_ROLES: 'SYSTEM_ADMIN' }],
    ['an empty demand role list', { PROCUREMENT_DEMAND_ROLES: '' }],
    ['an unknown role', { PROCUREMENT_DEMAND_ROLES: 'WIZARD' }],
    ['a window of zero hours', { PROCUREMENT_AGGREGATION_WINDOW_HOURS: '0' }],
    ['a window longer than a year', { PROCUREMENT_AGGREGATION_WINDOW_HOURS: '8761' }],
    ['a fractional window', { PROCUREMENT_AGGREGATION_WINDOW_HOURS: '1.5' }],
    ['a negative threshold', { PROCUREMENT_AGGREGATION_MIN_QUANTITY: '-1' }],
    [
      'a threshold past MAX_QUANTITY, which no window could reach (PR-300 r2 R2-1)',
      { PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(MAX_QUANTITY + 1) },
    ],
    [
      'a shortfall policy outside the closed set',
      { PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'WAIT' },
    ],
    ['a zero idempotency lifetime', { PROCUREMENT_IDEMPOTENCY_TTL_HOURS: '0' }],
    ['a lease under ten seconds', { PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '5' }],
  ])('refuses %s at startup', (_label, change) => {
    expect(() => load(change)).toThrow();
  });
});

describe('corsOrigins', () => {
  it('splits, trims and drops empties', () => {
    expect(corsOrigins(load({ CORS_ORIGINS: ' https://a.test , ,https://b.test ' }))).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('is empty by default, and falls back to the gateway’s list', () => {
    expect(corsOrigins(load())).toEqual([]);
    expect(corsOrigins(load({ GATEWAY_CORS_ORIGINS: 'https://gw.test' }))).toEqual([
      'https://gw.test',
    ]);
  });
});

describe('DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets (#268 r4)', () => {
  it('unset, applies no statement timeout', () => {
    const env = load();
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
    expect(env.DATABASE_URL).not.toContain('statement_timeout');
  });

  it('declares every budget, at the defaults', () => {
    expect(procurementOperationBudgets(load()).map((b) => [b.name, b.budgetMs])).toEqual([
      ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
      ['IN_FLIGHT_WAIT_MS', 7000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
    ]);
  });

  it('set, must be above the largest: the outbox renewal; the bound is exact', () => {
    expect(() => load({ DATABASE_STATEMENT_TIMEOUT_MS: '12500' })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(12500 ms\) is not above OUTBOX_CLAIM_LEASE_SECONDS, 12500 ms/,
    );
    expect(() => load({ DATABASE_STATEMENT_TIMEOUT_MS: '12501' })).not.toThrow();
  });
});
