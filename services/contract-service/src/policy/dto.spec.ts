import { RastaError, zodPipe } from '@rasta/nest-common';
import { createPolicySchema } from './dto';

describe('createPolicySchema: a chain step’s bounds', () => {
  const step = (bounds: object) => ({
    authorityOrganizationId: 'ORG_E',
    authorityRole: 'ORGANIZATION_ADMIN',
    authorityLabel: 'مدیر عامل',
    ...bounds,
  });
  const body = (bounds: object) => ({
    organizationId: 'ORG_E',
    workflowKey: 'contract.statement.technical',
    label: 'Who approves a statement',
    rationale: 'Decided by the union for the unit suite',
    steps: [step(bounds)],
  });

  /** What the validation pipe answers: the error it throws, never anything else. */
  const refusal = (bounds: object): RastaError => {
    try {
      zodPipe(createPolicySchema).transform(body(bounds), { type: 'body' });
    } catch (error) {
      if (error instanceof RastaError) return error;
      throw error;
    }
    throw new Error('the body was accepted');
  };

  it.each([
    ['a decimal minimum', '12.5', '100', 'minAmountMinor'],
    ['a decimal maximum', '0', '12.5', 'maxAmountMinor'],
    ['free text for the maximum', '0', 'private free text', 'maxAmountMinor'],
    ['free text for the minimum', 'private free text', '100', 'minAmountMinor'],
    ['an exponent', '1e3', '100000', 'minAmountMinor'],
    ['a negative minimum', '-1', '100', 'minAmountMinor'],
  ])(
    'reports %s as that bound’s 400, never a thrown SyntaxError, and never repeats it',
    (_label, minAmountMinor, maxAmountMinor, field) => {
      const error = refusal({ minAmountMinor, maxAmountMinor });
      expect(error.code).toBe('VALIDATION_FAILED');
      // Only that bound is reported (a negative one twice: its pattern, and below zero).
      expect(new Set(error.details?.map((detail) => detail.path))).toEqual(
        new Set([`steps[0].${field}`]),
      );
      const told = JSON.stringify(error.details);
      expect(told).not.toContain('private free text');
      expect(told).not.toContain('12.5');
      expect(told).not.toContain('1e3');
    },
  );

  it('refuses two malformed bounds each as itself, and compares neither', () => {
    const error = refusal({ minAmountMinor: '12.5', maxAmountMinor: 'private free text' });
    expect(error.details?.map((detail) => detail.path)).toEqual([
      'steps[0].minAmountMinor',
      'steps[0].maxAmountMinor',
    ]);
  });

  it.each([
    ['an empty range', '10', '10'],
    ['an inverted range', '11', '10'],
    ['an inverted range past 2^53', '9007199254740993', '9007199254740992'],
  ])('compares two well-formed bounds as integers: %s is refused', (_label, min, max) => {
    const error = refusal({ minAmountMinor: min, maxAmountMinor: max });
    expect(error.details).toEqual([
      {
        path: 'steps[0].maxAmountMinor',
        code: 'custom',
        message: 'minAmountMinor must be less than maxAmountMinor',
      },
    ]);
  });

  it('accepts a range whose minimum is below its maximum, or a single bound', () => {
    for (const bounds of [
      { minAmountMinor: '0', maxAmountMinor: '1' },
      { minAmountMinor: '9007199254740992', maxAmountMinor: '9007199254740993' },
      { minAmountMinor: '10' },
      { maxAmountMinor: '10' },
      {},
    ]) {
      expect(createPolicySchema.safeParse(body(bounds)).success).toBe(true);
    }
  });
});
