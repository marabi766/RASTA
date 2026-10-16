import { BUSINESS_LINES, businessLineSchema } from './business-line';

/**
 * The seven lines ADR-045 § 1 names, and nothing else. economic-service's
 * `BusinessLine` enum is held to this list by its own spec, so a line added
 * on one side only fails a build rather than a settlement.
 */
describe('businessLineSchema', () => {
  it('is exactly the seven lines of ADR-045 § 1', () => {
    expect([...BUSINESS_LINES]).toEqual([
      'PARTS',
      'INSURANCE',
      'MAINTENANCE',
      'LOGISTICS',
      'PROCUREMENT',
      'CONSTRUCTION',
      'MARKETPLACE_SERVICE',
    ]);
  });

  it('refuses a transaction type, a lower-case line and an empty string', () => {
    for (const value of ['MARKETPLACE_ORDER', 'parts', '', 'MAINTENANCE_SERVICE']) {
      expect(businessLineSchema.safeParse(value).success).toBe(false);
    }
  });
});
