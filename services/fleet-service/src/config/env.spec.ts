import { dispatchPolicyFromEnv, fleetEnvSchema, parkingFromEnv } from './env';

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
