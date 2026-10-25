import { envEnumProbes } from '@rasta/config';
import { corsOrigins, inventoryEnvSchema, loadInventoryEnv } from './env';
import { inventoryOperationBudgets } from './operation-budgets';

const base: NodeJS.ProcessEnv = {
  KAFKA_BROKERS: 'localhost:9092',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_inventory?schema=public',
};

const load = (overrides: NodeJS.ProcessEnv = {}) => loadInventoryEnv({ ...base, ...overrides });

describe('the provisional defaults (Q-102, Q-103)', () => {
  const env = load();

  it('operates and reads a warehouse as ORGANIZATION_ADMIN only (Q-103)', () => {
    expect(env.INVENTORY_OPERATOR_ROLES).toEqual(['ORGANIZATION_ADMIN']);
    expect(env.INVENTORY_READER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('lets a shipment’s consignee read it as ORGANIZATION_ADMIN only (Q-113)', () => {
    expect(env.INVENTORY_CONSIGNEE_READER_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('allows no return disposition until the deployment names one (Q-133)', () => {
    expect(env.INVENTORY_RETURN_DISPOSITIONS_ALLOWED).toEqual([]);
    expect(
      load({ INVENTORY_RETURN_DISPOSITIONS_ALLOWED: ' SCRAP , RESTOCK ' })
        .INVENTORY_RETURN_DISPOSITIONS_ALLOWED,
    ).toEqual(['SCRAP', 'RESTOCK']);
    expect(() => load({ INVENTORY_RETURN_DISPOSITIONS_ALLOWED: 'REFUND' })).toThrow(
      /Unknown disposition/,
    );
  });

  it('resolves no return of which nothing arrived until the deployment says so (Q-133 (4))', () => {
    expect(env.INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED).toBe(false);
    expect(
      load({ INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: 'true' })
        .INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED,
    ).toBe(true);
    // Only the two words: a typo is a failed start, never a silent false.
    expect(() => load({ INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: 'yes' })).toThrow();
  });

  it('configures no shipment state, cancellation or stock link the documents leave open (Q-114, Q-115)', () => {
    expect(
      Object.keys(env).filter((name) => /SHIPMENT|FAILED|CANCEL|CHECKPOINT/.test(name)),
    ).toEqual([]);
  });

  it('gives a reservation no default lifetime, only a seven-day cap on the one a caller sets (Q-102)', () => {
    expect(env.INVENTORY_RESERVATION_MAX_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(Object.keys(env).filter((name) => /DEFAULT_TTL/.test(name))).toEqual([]);
  });

  it('sweeps due reservations every 30 seconds, 100 at a time', () => {
    expect(env.INVENTORY_RESERVATION_SWEEP_INTERVAL_SECONDS).toBe(30);
    expect(env.INVENTORY_RESERVATION_SWEEP_BATCH_SIZE).toBe(100);
  });

  it('expires at most 20 due reservations of one stock item per transaction', () => {
    expect(env.INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE).toBe(20);
  });

  it('waits at most five seconds for a stock item another command holds', () => {
    expect(env.INVENTORY_LOCK_TIMEOUT_MS).toBe(5000);
  });

  it('asks marketplace, which owns the return request, on its port, for three seconds at most', () => {
    expect(env.MARKETPLACE_SERVICE_URL).toBe('http://localhost:3106');
    expect(env.INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS).toBe(3000);
  });

  it('replays a command’s response for a day and leases an in-flight key for two minutes', () => {
    expect(env.INVENTORY_IDEMPOTENCY_TTL_HOURS).toBe(24);
    expect(env.INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS).toBe(120);
  });

  it('configures no business rule the documents leave open (Q-105 to Q-109)', () => {
    expect(
      Object.keys(env).filter((name) => /THRESHOLD|UNIT|PARTIAL|REASON|FOUR_EYES/.test(name)),
    ).toEqual([]);
  });

  it('names itself, and listens on 3109', () => {
    expect(env.SERVICE_NAME).toBe('inventory-service');
    expect(env.PORT).toBe(3109);
    expect(env.KAFKA_CLIENT_ID).toBe('inventory-service');
  });
});

describe('overrides', () => {
  it('takes the port from PORT_INVENTORY and the database from DATABASE_URL_INVENTORY', () => {
    const env = loadInventoryEnv({
      ...base,
      DATABASE_URL: undefined,
      DATABASE_URL_INVENTORY: 'postgresql://u:p@db:5433/rasta_inventory?schema=public',
      PORT_INVENTORY: '4109',
    });
    expect(env.PORT).toBe(4109);
    expect(env.DATABASE_URL).toContain('@db:5433/rasta_inventory');
  });

  it('does not fall back to another service’s database variable', () => {
    expect(() =>
      loadInventoryEnv({
        ...base,
        DATABASE_URL: undefined,
        DATABASE_URL_MARKETPLACE: 'postgresql://u:p@db:5433/rasta_marketplace',
      }),
    ).toThrow();
  });

  it('accepts configured role lists, trimmed', () => {
    const env = load({
      INVENTORY_OPERATOR_ROLES: ' ORGANIZATION_ADMIN , UNION_ADMIN ',
      INVENTORY_READER_ROLES: 'PROCUREMENT_USER',
    });
    expect(env.INVENTORY_OPERATOR_ROLES).toEqual(['ORGANIZATION_ADMIN', 'UNION_ADMIN']);
    expect(env.INVENTORY_READER_ROLES).toEqual(['PROCUREMENT_USER']);
  });

  it.each([
    ['AUDITOR among the operators', { INVENTORY_OPERATOR_ROLES: 'AUDITOR' }],
    ['AUDITOR among the readers', { INVENTORY_READER_ROLES: 'ORGANIZATION_ADMIN,AUDITOR' }],
    ['SYSTEM_ADMIN among the operators', { INVENTORY_OPERATOR_ROLES: 'SYSTEM_ADMIN' }],
    ['SYSTEM_ADMIN among the readers', { INVENTORY_READER_ROLES: 'SYSTEM_ADMIN' }],
    ['an empty operator list', { INVENTORY_OPERATOR_ROLES: '' }],
    ['an empty reader list', { INVENTORY_READER_ROLES: ' , ' }],
    ['an unknown role', { INVENTORY_READER_ROLES: 'WIZARD' }],
    ['AUDITOR among the consignee readers', { INVENTORY_CONSIGNEE_READER_ROLES: 'AUDITOR' }],
    [
      'SYSTEM_ADMIN among the consignee readers',
      { INVENTORY_CONSIGNEE_READER_ROLES: 'SYSTEM_ADMIN' },
    ],
    ['an empty consignee reader list', { INVENTORY_CONSIGNEE_READER_ROLES: '' }],
    ['a reservation cap under a minute', { INVENTORY_RESERVATION_MAX_TTL_SECONDS: '59' }],
    ['a reservation cap over a year', { INVENTORY_RESERVATION_MAX_TTL_SECONDS: '40000000' }],
    ['a zero sweep interval', { INVENTORY_RESERVATION_SWEEP_INTERVAL_SECONDS: '0' }],
    ['a zero sweep batch', { INVENTORY_RESERVATION_SWEEP_BATCH_SIZE: '0' }],
    ['a zero expiry batch', { INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE: '0' }],
    ['an expiry batch over 500', { INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE: '501' }],
    ['a lock timeout under 100 ms', { INVENTORY_LOCK_TIMEOUT_MS: '10' }],
    ['a lock timeout over a minute', { INVENTORY_LOCK_TIMEOUT_MS: '60001' }],
    ['a zero idempotency lifetime', { INVENTORY_IDEMPOTENCY_TTL_HOURS: '0' }],
    ['a lease under ten seconds', { INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: '5' }],
    ['a marketplace address that is not a URL', { MARKETPLACE_SERVICE_URL: 'marketplace' }],
    ['a marketplace timeout under 200 ms', { INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS: '50' }],
    [
      'a marketplace timeout over ten seconds',
      { INVENTORY_MARKETPLACE_REQUEST_TIMEOUT_MS: '10001' },
    ],
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
    expect(inventoryOperationBudgets(load()).map((b) => [b.name, b.budgetMs])).toEqual([
      ['IN_FLIGHT_WAIT_MS', 7000],
      ['INVENTORY_LOCK_TIMEOUT_MS', 30_000],
      ['INVENTORY_LOCK_TIMEOUT_MS (expiry)', 20_000],
      ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
    ]);
  });

  it('set, must be above the largest: a stock command, 4 × the lock timeout + 10 s; the bound is exact', () => {
    expect(() => load({ DATABASE_STATEMENT_TIMEOUT_MS: '30000' })).toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS: \(30000 ms\) is not above INVENTORY_LOCK_TIMEOUT_MS, 30000 ms/,
    );
    expect(() => load({ DATABASE_STATEMENT_TIMEOUT_MS: '30001' })).not.toThrow();
  });

  it('moves with the lock timeout: a longer one raises the floor, a shorter one leaves the renewal', () => {
    expect(() =>
      load({ INVENTORY_LOCK_TIMEOUT_MS: '60000', DATABASE_STATEMENT_TIMEOUT_MS: '250000' }),
    ).toThrow(/not above INVENTORY_LOCK_TIMEOUT_MS, 250000 ms/);
    expect(() =>
      load({ INVENTORY_LOCK_TIMEOUT_MS: '60000', DATABASE_STATEMENT_TIMEOUT_MS: '250001' }),
    ).not.toThrow();
    expect(() =>
      load({ INVENTORY_LOCK_TIMEOUT_MS: '100', DATABASE_STATEMENT_TIMEOUT_MS: '12500' }),
    ).toThrow(/not above OUTBOX_CLAIM_LEASE_SECONDS, 12500 ms/);
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
    inventoryEnvSchema,
    (source) => loadInventoryEnv(source),
    base,
    SENTINELS,
  );

  it('are found by walking the schema, the ones the r2 review named among them', () => {
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'LOG_LEVEL',
        'KAFKA_SASL_MECHANISM',
        'INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED',
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
