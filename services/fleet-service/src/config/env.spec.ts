import { envEnumProbes } from '@rasta/config';
import { CONSUMER_SESSION_TIMEOUT_MS } from '@rasta/nest-common';
import {
  assetSyncBudgetProblem,
  assetSyncDeliveryWorstCaseMs,
  dispatchPolicyFromEnv,
  fleetEnvSchema,
  loadFleetEnv,
  parkingFromEnv,
} from './env';
import { fleetOperationBudgets } from './operation-budgets';

/** #240 r9: no asset-sync transaction may expire while it holds, or waits on, a lock across upstream calls. */
describe('FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS', () => {
  const MINIMAL: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://rasta_fleet:pw@127.0.0.1:5433/rasta_fleet?schema=public',
    KAFKA_BROKERS: 'localhost:9092',
    REDIS_URL: 'redis://127.0.0.1:6379',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
    ASSET_SERVICE_URL: 'http://localhost:3102',
    MAINTENANCE_SERVICE_URL: 'http://localhost:3106',
    IDENTITY_SERVICE_URL: 'http://localhost:3101',
  };

  it('defaults to 14.2 s and a 500 ms start wait, which cover three calls at the default upstream timeout and fit a delivery in the session (r12)', () => {
    const env = loadFleetEnv(MINIMAL);
    expect(env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS).toBe(14_200);
    expect(env.FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS).toBe(500);
    expect(env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS).toBe(3_000);
    expect(assetSyncBudgetProblem(env)).toBeUndefined();
    // Three attempts of (0.5 s reads + 3 s call + 0.5 s start wait + 14.2 s) and
    // pauses of 0.5 s and 1 s: under 60 s less the 3 s margin.
    expect(assetSyncDeliveryWorstCaseMs(env)).toBe(56_100);
    expect(CONSUMER_SESSION_TIMEOUT_MS).toBe(60_000);
  });

  it('refuses to start when the transactions would not outlive the upstream calls (fail closed)', () => {
    expect(() =>
      loadFleetEnv({ ...MINIMAL, ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '4000' }),
    ).toThrow(
      /FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS \(14200 ms\) must exceed 3 × ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS \(4000 ms\) \+ 5000 ms = 17000 ms/,
    );
  });

  it('holds the margin exactly: equal is refused, one millisecond more is accepted', () => {
    const at = (transaction: number) =>
      assetSyncBudgetProblem({
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: transaction,
        FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS: 500,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: 3_000,
      });
    expect(at(14_000)).toMatch(/must exceed/);
    expect(at(14_001)).toBeUndefined();
  });

  it('r11, r12: refuses a delivery that could outlast the consumer session, start waits and reads included; the bound is exact', () => {
    const at = (transaction: number, upstream = 3_000, maxWait = 500) =>
      assetSyncBudgetProblem({
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: transaction,
        FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS: maxWait,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: upstream,
      });
    // 3 × (2 × 0.5 s + 3 s + 14.5 s) + 1.5 s = 57 s: allowed. One millisecond more is not.
    expect(at(14_500)).toBeUndefined();
    expect(at(14_501)).toMatch(
      /one asset-sync delivery can take 3 × \(2 × FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS \(500 ms\) .* = 57003 ms, more than the consumer session timeout \(60000 ms\) less 3000 ms = 57000 ms/,
    );
    // The r11 default (15 s) fitted only while the start wait and the reads were
    // left out: with Prisma's own 2 s it is 67.5 s; with 500 ms still 58.5 s.
    expect(at(15_000, 3_000, 2_000)).toMatch(/= 67500 ms/);
    expect(at(15_000)).toMatch(/= 58500 ms/);
    // The start wait is held to the same bound: at the default transaction
    // timeout, 650 ms fits exactly and 651 ms does not.
    expect(at(14_200, 3_000, 650)).toBeUndefined();
    expect(at(14_200, 3_000, 651)).toMatch(/= 57006 ms/);
    expect(() =>
      loadFleetEnv({ ...MINIMAL, FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS: '2000' }),
    ).toThrow(/consumer session timeout/);
    expect(() =>
      loadFleetEnv({ ...MINIMAL, FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '30000' }),
    ).toThrow(/consumer session timeout/);
    // While the refresh asks under the lock, no upstream timeout above about 3.12 s
    // satisfies both rules at the default start wait: the smallest transaction it
    // needs is already too long.
    expect(at(3 * 3_124 + 5_001, 3_124)).toBeUndefined();
    expect(at(3 * 3_125 + 5_001, 3_125)).toMatch(/consumer session timeout/);
    expect(at(3 * 3_125 + 5_000, 3_125)).toMatch(/must exceed/);
  });

  describe('#268 r4: DATABASE_STATEMENT_TIMEOUT_MS against the operation budgets', () => {
    const at =
      (statementTimeoutMs: number, overrides: NodeJS.ProcessEnv = {}) =>
      () =>
        loadFleetEnv({
          ...MINIMAL,
          ...overrides,
          DATABASE_STATEMENT_TIMEOUT_MS: String(statementTimeoutMs),
        });

    it('unset, applies no statement timeout', () => {
      const env = loadFleetEnv(MINIMAL);
      expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeUndefined();
      expect(env.DATABASE_URL).not.toContain('statement_timeout');
    });

    it('declares every budget, at the defaults', () => {
      expect(fleetOperationBudgets(loadFleetEnv(MINIMAL)).map((b) => [b.name, b.budgetMs])).toEqual(
        [
          ['PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS', 5000],
          ['IN_FLIGHT_WAIT_MS', 7000],
          ['FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS', 14_200],
          ['OUTBOX_CLAIM_LEASE_SECONDS', 12_500],
          ['OUTBOX_PURGE_STATEMENT_TIMEOUT_MS', 10_000],
        ],
      );
    });

    it('set, must be above the largest: the asset-sync transaction timeout; the bound is exact', () => {
      // Others wait on the refresh's lock for as long as its transaction may run.
      expect(at(14_200)).toThrow(
        /DATABASE_STATEMENT_TIMEOUT_MS: \(14200 ms\) is not above FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS, 14200 ms/,
      );
      expect(at(14_201)).not.toThrow();
    });

    it('a shorter asset-sync timeout lowers the floor to the next budget, the outbox renewal', () => {
      // Still above 3 × the upstream timeout + 5 s, as the budget above asks.
      const short = {
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '11999',
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '2000',
      };
      expect(at(12_500, short)).toThrow(/not above OUTBOX_CLAIM_LEASE_SECONDS, 12500 ms/);
      expect(at(12_501, short)).not.toThrow();
    });
  });

  it('refuses a transaction timeout longer than the session timeout, and a start wait out of range, in the schema', () => {
    expect(() =>
      loadFleetEnv({ ...MINIMAL, FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '60001' }),
    ).toThrow();
    const maxWait = fleetEnvSchema.shape.FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS;
    expect(maxWait.safeParse('49').success).toBe(false);
    expect(maxWait.safeParse('10001').success).toBe(false);
    expect(maxWait.safeParse('1.5').success).toBe(false);
    expect(maxWait.parse('50')).toBe(50);
  });
});

/** #240 r8: the parked-insurance sweep. */
/**
 * #385 r4, the rule for numbers: the budget refusal prints the three timeouts,
 * which the schema has read as numbers first. Written as text, each is refused
 * by the schema with a fixed message, never repeated.
 */
describe('the asset-sync budget settings, written as text', () => {
  const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'];
  const MINIMAL: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://rasta_fleet:pw@127.0.0.1:5433/rasta_fleet?schema=public',
    KAFKA_BROKERS: 'localhost:9092',
    REDIS_URL: 'redis://127.0.0.1:6379',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
    ASSET_SERVICE_URL: 'http://localhost:3102',
    MAINTENANCE_SERVICE_URL: 'http://localhost:3106',
  };
  const refusal = (source: NodeJS.ProcessEnv): Error => {
    try {
      loadFleetEnv(source);
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a refusal');
  };

  it.each([
    'FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS',
    'FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS',
    'ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS',
  ])('%s is refused before the budget check can print it', (name) => {
    const [a, b] = SENTINELS.map((value) => refusal({ ...MINIMAL, [name]: value }));
    expect(a?.message).toBe(b?.message);
    expect(a?.message).toContain(name);
    for (const error of [a, b]) {
      expect(`${error?.message}\n${error?.stack}`).not.toMatch(/sentinel|jz97|another[-_]secret/i);
    }
  });
});

describe('FLEET_INSURANCE_PARKED_*', () => {
  const shape = fleetEnvSchema.shape;

  it('defaults to a five-minute age, twelve attempts, a minute between sweeps, fifty a run', () => {
    expect(
      parkingFromEnv({
        FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS:
          shape.FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS.parse(undefined),
        FLEET_INSURANCE_PARKED_MAX_ATTEMPTS:
          shape.FLEET_INSURANCE_PARKED_MAX_ATTEMPTS.parse(undefined),
        FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS:
          shape.FLEET_INSURANCE_PARKED_SWEEP_INTERVAL_SECONDS.parse(undefined),
        FLEET_INSURANCE_PARKED_SWEEP_BATCH:
          shape.FLEET_INSURANCE_PARKED_SWEEP_BATCH.parse(undefined),
      }),
    ).toEqual({ minAgeSeconds: 300, maxAttempts: 12, sweepIntervalMs: 60_000, batchSize: 50 });
  });

  it('refuses a bound that would sweep constantly or never dead-letter', () => {
    expect(shape.FLEET_INSURANCE_PARKED_MIN_AGE_SECONDS.safeParse('5').success).toBe(false);
    expect(shape.FLEET_INSURANCE_PARKED_MAX_ATTEMPTS.safeParse('0').success).toBe(false);
    expect(shape.FLEET_INSURANCE_PARKED_SWEEP_BATCH.safeParse('5000').success).toBe(false);
  });
});

/** The Q-101 setting: parsed at start-up, failing closed. */
describe('FLEET_DISPATCH_REQUIRED_COVERAGES', () => {
  const field = fleetEnvSchema.shape.FLEET_DISPATCH_REQUIRED_COVERAGES;
  const blocking = fleetEnvSchema.shape.FLEET_DISPATCH_BLOCKING_COVERAGES;

  it('is unset by default, so the policy falls back to the blocking set', () => {
    const required = field.parse(undefined);
    expect(required).toBeUndefined();
    const policy = dispatchPolicyFromEnv({
      FLEET_DISPATCH_BLOCKING_COVERAGES: blocking.parse('THIRD_PARTY,LIABILITY'),
      FLEET_DISPATCH_REQUIRED_COVERAGES: required,
    });
    expect(policy.requiredCoverages).toEqual(['THIRD_PARTY', 'LIABILITY']);
  });

  it('reads a trimmed list, and an empty string as "require none"', () => {
    expect(field.parse(' THIRD_PARTY , LIABILITY ')).toEqual(['THIRD_PARTY', 'LIABILITY']);
    expect(field.parse('')).toEqual([]);
    const policy = dispatchPolicyFromEnv({
      FLEET_DISPATCH_BLOCKING_COVERAGES: blocking.parse(undefined),
      FLEET_DISPATCH_REQUIRED_COVERAGES: field.parse(''),
    });
    expect(policy.requiredCoverages).toEqual([]);
  });

  it('refuses an unknown coverage rather than requiring nothing', () => {
    expect(field.safeParse('THIRD_PARTY,FIRE').success).toBe(false);
    expect(field.safeParse('third_party').success).toBe(false);
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
    fleetEnvSchema,
    (source) => loadFleetEnv(source),
    {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://rasta_fleet:pw@127.0.0.1:5433/rasta_fleet?schema=public',
      KAFKA_BROKERS: 'localhost:9092',
      REDIS_URL: 'redis://127.0.0.1:6379',
      OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
      OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/certs',
      OIDC_AUDIENCE: 'rasta-api',
      INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
      ASSET_SERVICE_URL: 'http://localhost:3102',
      MAINTENANCE_SERVICE_URL: 'http://localhost:3106',
    },
    SENTINELS,
  );

  it('are found by walking the schema, the ones the r2 review named among them', () => {
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'LOG_LEVEL',
        'KAFKA_SASL_MECHANISM',
        'FLEET_DISPATCH_BLOCKING_COVERAGES',
        'FLEET_DISPATCH_REQUIRED_COVERAGES',
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
