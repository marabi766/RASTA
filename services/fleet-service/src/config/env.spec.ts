import { dispatchPolicyFromEnv, fleetEnvSchema } from './env';

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
