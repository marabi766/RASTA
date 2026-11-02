import { envEnumProbes } from '@rasta/config';
import { randomBytes } from 'node:crypto';
import { MAX_QUANTITY } from '../demand/dto';
import {
  corsOrigins,
  loadProcurementEnv,
  procurementEnvSchema,
  MAX_FOLLOW_BATCH_SIZE,
  DEFAULT_MAX_LIVE_DEMANDS,
  MAX_INVITEES_LIMIT,
  MAX_LIVE_DEMANDS_LIMIT,
} from './env';
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

  it('lets only the buyer’s ORGANIZATION_ADMIN cancel an aggregation (ADR-070 § 3)', () => {
    expect(env.PROCUREMENT_RFQ_ISSUER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('lets only the buyer’s ORGANIZATION_ADMIN record its aggregation settings (Q-119 (2), plan PR 3)', () => {
    expect(env.PROCUREMENT_AGGREGATION_SETTING_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('sweeps every five seconds, twenty windows under a one-minute lease, and moves 2000 demands a transaction', () => {
    expect(env.PROCUREMENT_WINDOW_SWEEP_INTERVAL_MS).toBe(5000);
    expect(env.PROCUREMENT_WINDOW_SWEEP_BATCH_SIZE).toBe(20);
    expect(env.PROCUREMENT_WINDOW_SWEEP_LEASE_SECONDS).toBe(60);
    expect(env.PROCUREMENT_WINDOW_SWEEP_BACKOFF_BASE_SECONDS).toBe(10);
    expect(env.PROCUREMENT_WINDOW_SWEEP_BACKOFF_MAX_SECONDS).toBe(900);
    expect(env.PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE).toBe(2000);
  });

  it('replays a command’s response for a day and leases an in-flight key for two minutes', () => {
    expect(env.PROCUREMENT_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(env.PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(120);
  });

  it('holds a window to 200,000 live demands, a tenth of what one transaction digests whole (Q-119 note of 2026-10-17, PR-338 r1 F1)', () => {
    expect(env.PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS).toBe(200_000);
  });

  it('names itself, and listens on 3107', () => {
    expect(env.SERVICE_NAME).toBe('procurement-service');
    expect(env.PORT).toBe(3107);
    expect(env.KAFKA_CLIENT_ID).toBe('procurement-service');
  });

  it('has no setting that names an amount, an approver or a supplier organization', () => {
    // The supplier side's roles, where supplier-service answers and how long it may take (plan
    // PR 6): none names a supplier.
    const named = Object.keys(env).filter((name) => /AMOUNT|APPROV|SUPPLIER|PRICE/.test(name));
    expect(named.sort()).toEqual([
      'PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS',
      'PROCUREMENT_SUPPLIER_ROLES',
      'SUPPLIER_SERVICE_URL',
    ]);
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
    ['one', 1],
    ['MAX_LIVE_DEMANDS_LIMIT, half of what one transaction digests whole', 1_000_000],
  ])('accepts a live-demand limit of %s', (_label, limit) => {
    expect(
      load({ PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: String(limit) })
        .PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS,
    ).toBe(limit);
    expect(MAX_LIVE_DEMANDS_LIMIT).toBe(1_000_000);
    expect(DEFAULT_MAX_LIVE_DEMANDS).toBe(200_000);
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
    ['a live-demand limit of zero', { PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: '0' }],
    [
      'a live-demand limit past half of what one transaction digests whole',
      { PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: '1000001' },
    ],
    ['a fractional live-demand limit', { PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: '2.5' }],
    ['a zero idempotency lifetime', { PROCUREMENT_IDEMPOTENCY_TTL_HOURS: '0' }],
    ['a lease under ten seconds', { PROCUREMENT_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '5' }],
    ['AUDITOR among the RFQ issuer roles', { PROCUREMENT_RFQ_ISSUER_ROLES: 'AUDITOR' }],
    [
      'SYSTEM_ADMIN among the RFQ issuer roles',
      { PROCUREMENT_RFQ_ISSUER_ROLES: 'ORGANIZATION_ADMIN,SYSTEM_ADMIN' },
    ],
    ['an empty RFQ issuer role list', { PROCUREMENT_RFQ_ISSUER_ROLES: '' }],
    ['AUDITOR among the setting roles', { PROCUREMENT_AGGREGATION_SETTING_ROLES: 'AUDITOR' }],
    [
      'SYSTEM_ADMIN among the setting roles: the operator does not write a tenant’s configuration',
      { PROCUREMENT_AGGREGATION_SETTING_ROLES: 'ORGANIZATION_ADMIN,SYSTEM_ADMIN' },
    ],
    ['an empty setting role list', { PROCUREMENT_AGGREGATION_SETTING_ROLES: '' }],
    ['a sweep more often than twice a second', { PROCUREMENT_WINDOW_SWEEP_INTERVAL_MS: '499' }],
    ['a sweep of no window', { PROCUREMENT_WINDOW_SWEEP_BATCH_SIZE: '0' }],
    ['a sweep lease under ten seconds', { PROCUREMENT_WINDOW_SWEEP_LEASE_SECONDS: '9' }],
    ['a follow batch of no demand', { PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: '0' }],
    [
      'a follow batch past MAX_FOLLOW_BATCH_SIZE, which the transaction budget does not hold',
      { PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: String(MAX_FOLLOW_BATCH_SIZE + 1) },
    ],
  ])('refuses %s at startup', (_label, change) => {
    expect(() => load(change)).toThrow();
  });

  it('accepts a follow batch of exactly MAX_FOLLOW_BATCH_SIZE', () => {
    expect(
      load({ PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: String(MAX_FOLLOW_BATCH_SIZE) })
        .PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE,
    ).toBe(MAX_FOLLOW_BATCH_SIZE);
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

describe('the RFQ settings (ADR-070 § 3, § 4; plan PR 6)', () => {
  const kek = () => randomBytes(32).toString('base64');

  it('invites at most 200 by default, bounded 1 to 500; the supplier side is SUPPLIER; the sweeper is the window’s shape', () => {
    const env = load();
    expect(env.PROCUREMENT_RFQ_MAX_INVITEES).toBe(200);
    expect(env.PROCUREMENT_SUPPLIER_ROLES).toEqual(['SUPPLIER']);
    expect(env.SUPPLIER_SERVICE_URL).toBe('http://localhost:3108');
    expect(env.PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS).toBe(5000);
    expect([
      env.PROCUREMENT_RFQ_CLOSE_SWEEP_INTERVAL_MS,
      env.PROCUREMENT_RFQ_CLOSE_SWEEP_BATCH_SIZE,
      env.PROCUREMENT_RFQ_CLOSE_SWEEP_LEASE_SECONDS,
      env.PROCUREMENT_RFQ_CLOSE_SWEEP_BACKOFF_BASE_SECONDS,
      env.PROCUREMENT_RFQ_CLOSE_SWEEP_BACKOFF_MAX_SECONDS,
    ]).toEqual([5000, 20, 60, 10, 900]);
    const atMost = load({ PROCUREMENT_RFQ_MAX_INVITEES: String(MAX_INVITEES_LIMIT) });
    expect(atMost.PROCUREMENT_RFQ_MAX_INVITEES).toBe(500);
    for (const bad of ['0', String(MAX_INVITEES_LIMIT + 1)]) {
      expect(() => load({ PROCUREMENT_RFQ_MAX_INVITEES: bad })).toThrow(
        /PROCUREMENT_RFQ_MAX_INVITEES/,
      );
    }
  });

  it('cancels for BUYER_REQUEST by default; the closed list is the client’s (the planned CancelRfq)', () => {
    expect(load().PROCUREMENT_RFQ_CANCELLATION_CODES).toEqual(['BUYER_REQUEST']);
    expect(
      load({ PROCUREMENT_RFQ_CANCELLATION_CODES: ' BUYER_REQUEST , BUDGET_WITHDRAWN ' })
        .PROCUREMENT_RFQ_CANCELLATION_CODES,
    ).toEqual(['BUYER_REQUEST', 'BUDGET_WITHDRAWN']);
  });

  it.each([
    ['', /at least one code/],
    ['buyer_request', /upper-case words/],
    ['BUYER REQUEST', /upper-case words/],
    [`B${'X'.repeat(64)}`, /upper-case words/],
    ['BUYER_REQUEST,BUYER_REQUEST', /names a code twice/],
    // Before evaluation (plan PR 10) nothing checks that no quotation qualified.
    ['BUYER_REQUEST,NO_QUALIFIED_QUOTATION', /NO_QUALIFIED_QUOTATION/],
  ])('refuses PROCUREMENT_RFQ_CANCELLATION_CODES=%p at startup', (codes, message) => {
    expect(() => load({ PROCUREMENT_RFQ_CANCELLATION_CODES: codes })).toThrow(message);
  });

  it.each(['AUDITOR', 'SYSTEM_ADMIN'])('refuses %s on the supplier side at startup', (role) => {
    expect(() => load({ PROCUREMENT_SUPPLIER_ROLES: `SUPPLIER,${role}` })).toThrow(
      /PROCUREMENT_SUPPLIER_ROLES/,
    );
  });

  it('has no RFQ key by default: no KEK, nothing wraps (the issue is then 503)', () => {
    const env = load();
    expect(env.PROCUREMENT_RFQ_KEKS).toBeUndefined();
    expect(env.PROCUREMENT_RFQ_KEK_CURRENT).toBeUndefined();
  });

  it('accepts KEKs with the current one among them, and refuses any other pairing without repeating a key', () => {
    const first = kek();
    const second = kek();
    const both = load({
      PROCUREMENT_RFQ_KEKS: `v1:${first},v2:${second}`,
      PROCUREMENT_RFQ_KEK_CURRENT: 'v2',
    });
    expect(both.PROCUREMENT_RFQ_KEK_CURRENT).toBe('v2');
    const wrong: [string, string | undefined][] = [
      [`v1:${first}`, 'v2'],
      [`v1:${first}`, undefined],
      ['', 'v1'],
      [`v1:${first.slice(4)}`, 'v1'],
      [`v1:${first}`, 'V1'],
    ];
    for (const [keys, current] of wrong) {
      let message = '';
      try {
        load({ PROCUREMENT_RFQ_KEKS: keys, PROCUREMENT_RFQ_KEK_CURRENT: current });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/PROCUREMENT_RFQ_KEK/);
      expect(message).not.toContain(first);
    }
  });
});

/**
 * Refusals never carry the value written (S-09, #385 r2 F2): every enum setting, found by
 * walking the schema rather than listed, set to each of two sentinels, is refused alike, with
 * neither in the issues, the error's message or its stack (what the startup log prints).
 */
describe('enum settings are refused without the value written (#385 r2 F2)', () => {
  const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'] as const;
  const probes = envEnumProbes(
    procurementEnvSchema,
    (source) => loadProcurementEnv(source),
    base,
    SENTINELS,
  );

  it('are found by walking the schema, the ones the r2 review named among them', () => {
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'LOG_LEVEL',
        'KAFKA_SASL_MECHANISM',
        'PROCUREMENT_AGGREGATION_SHORTFALL_POLICY',
      ]),
    );
  });

  it.each(probes.map((probe) => [probe.name, probe] as const))('%s', (name, probe) => {
    expect(probe.codes).toContain('invalid_enum_value');
    const [a, b] = probe.refusals;
    expect(a).toEqual(b);
    for (const sentinel of SENTINELS) expect(JSON.stringify(a)).not.toContain(sentinel);
    expect(a.issues.some((issue) => issue.path === name || issue.path.startsWith(`${name}.`))).toBe(
      true,
    );
  });
});
