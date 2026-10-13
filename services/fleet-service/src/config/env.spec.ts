import { CONSUMER_SESSION_TIMEOUT_MS } from '@rasta/nest-common';
import {
  assetSyncBudgetProblem,
  assetSyncDeliveryWorstCaseMs,
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

  it('defaults to 15 s, which covers three calls at the default upstream timeout and fits a delivery in the session (r11)', () => {
    const env = loadFleetEnv(MINIMAL);
    expect(env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS).toBe(15_000);
    expect(env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS).toBe(3_000);
    expect(assetSyncBudgetProblem(env)).toBeUndefined();
    // Three attempts of (3 s + 15 s) and pauses of 0.5 s and 1 s: under 60 s less the 3 s margin.
    expect(assetSyncDeliveryWorstCaseMs(env)).toBe(55_500);
    expect(CONSUMER_SESSION_TIMEOUT_MS).toBe(60_000);
  });

  it('refuses to start when the transactions would not outlive the upstream calls (fail closed)', () => {
    expect(() =>
      loadFleetEnv({ ...MINIMAL, ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: '4000' }),
    ).toThrow(
      /FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS \(15000 ms\) must exceed 3 × ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS \(4000 ms\) \+ 5000 ms = 17000 ms/,
    );
  });

  it('holds the margin exactly: equal is refused, one millisecond more is accepted', () => {
    const at = (transaction: number) =>
      assetSyncBudgetProblem({
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: transaction,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: 3_000,
      });
    expect(at(14_000)).toMatch(/must exceed/);
    expect(at(14_001)).toBeUndefined();
  });

  it('r11: refuses a delivery that could outlast the consumer session; the bound is exact', () => {
    const at = (transaction: number, upstream = 3_000) =>
      assetSyncBudgetProblem({
        FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: transaction,
        ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS: upstream,
      });
    // 3 × (3 s + 15.5 s) + 1.5 s = 57 s: allowed. One millisecond more is not.
    expect(at(15_500)).toBeUndefined();
    expect(at(15_501)).toMatch(
      /one asset-sync delivery can take 3 × .* = 57003 ms, more than the consumer session timeout \(60000 ms\) less 3000 ms = 57000 ms/,
    );
    // The old default no longer starts.
    expect(() =>
      loadFleetEnv({ ...MINIMAL, FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '30000' }),
    ).toThrow(/consumer session timeout/);
    // While the refresh asks under the lock, no upstream timeout above about 3.37 s
    // satisfies both rules: the smallest transaction it needs is already too long.
    expect(at(3 * 3_374 + 5_001, 3_374)).toBeUndefined();
    expect(at(3 * 3_375 + 5_001, 3_375)).toMatch(/consumer session timeout/);
    expect(at(3 * 3_375 + 5_000, 3_375)).toMatch(/must exceed/);
  });

  it('refuses a transaction timeout longer than the session timeout in the schema', () => {
    expect(() =>
      loadFleetEnv({ ...MINIMAL, FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS: '60001' }),
    ).toThrow();
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
