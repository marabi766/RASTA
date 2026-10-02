import { assetEnvSchema } from './env';

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
