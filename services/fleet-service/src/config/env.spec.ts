import {
  assetSyncBudgetProblem,
  dispatchPolicyFromEnv,
  fleetEnvSchema,
  loadFleetEnv,
  parkingFromEnv,
} from './env';

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
  };

  it('defaults to 30 s, which covers three calls at the default upstream timeout and the margin', () => {
    const env = loadFleetEnv(MINIMAL);
    expect(env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS).toBe(30_000);
    expect(env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS).toBe(3_000);
    expect(assetSyncBudgetProblem(env)).toBeUndefined();
  });

  it('refuses to start when the transactions would not outlive the upstream calls (fail closed)', () => {
    // The largest upstream timeout the schema allows, with the default transaction timeout.
    expect(() =>
      loadFleetEnv({ ...MINIMAL, ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '30000' }),
    ).toThrow(
      /FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS \(30000 ms\) must exceed 3 × ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS \(30000 ms\) \+ 5000 ms = 95000 ms/,
    );
    expect(
      loadFleetEnv({
        ...MINIMAL,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '30000',
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '95001',
      }).FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS,
    ).toBe(95_001);
  });

  it('holds the margin exactly: equal is refused, one millisecond more is accepted', () => {
    const at = (transaction: number) =>
      assetSyncBudgetProblem({
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: transaction,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: 5_000,
      });
    expect(at(20_000)).toMatch(/must exceed/);
    expect(at(20_001)).toBeUndefined();
  });
});

/** #240 r8: the parked-insurance sweep. */
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
