import {
  MAX_CRITERIA,
  createCriteriaTemplateSchema,
  criterionInputSchema,
  listCriteriaTemplatesQuerySchema,
  setCriteriaSchema,
} from './criteria.dto';

/** The boundary of the criteria commands (ADR-067 § 1): what is data, and what a body may not decide. */

const C = (overrides: Record<string, unknown> = {}) => ({
  code: 'PRICE',
  label: 'Price',
  weightBp: 4000,
  scoringMethod: 'MANUAL_SCORE',
  maxScore: 100,
  ...overrides,
});

describe('a criterion', () => {
  it('accepts a code, a label, a weight in basis points, a method and a maximum', () => {
    expect(criterionInputSchema.safeParse(C()).success).toBe(true);
  });

  it.each([
    ['a float weight', { weightBp: 40.5 }],
    ['a zero weight', { weightBp: 0 }],
    ['a weight above the whole', { weightBp: 10_001 }],
    ['an unknown scoring method', { scoringMethod: 'LOWEST_PRICE_RATIO' }],
    ['a zero maximum', { maxScore: 0 }],
    ['a fractional maximum', { maxScore: 2.5 }],
    ['a blank label', { label: '   ' }],
    ['a code with a space', { code: 'TECH SCORE' }],
    ['a code that starts with a dot', { code: '.PRICE' }],
    ['a position of its own', { position: 3 }],
    ['an owner', { organizationId: 'ORG_X' }],
  ])('refuses %s', (_label, overrides) => {
    expect(criterionInputSchema.safeParse(C(overrides)).success).toBe(false);
  });

  it('scores a PASS_FAIL criterion 0 or 1, and no other way', () => {
    expect(
      criterionInputSchema.safeParse(C({ scoringMethod: 'PASS_FAIL', maxScore: 1 })).success,
    ).toBe(true);
    expect(
      criterionInputSchema.safeParse(C({ scoringMethod: 'PASS_FAIL', maxScore: 10 })).success,
    ).toBe(false);
  });
});

describe('a list of criteria', () => {
  const template = (criteria: unknown[]) =>
    createCriteriaTemplateSchema.safeParse({ label: 'Roads', criteria });

  it('allows weights that sum to the whole or to less (a draft), never to more', () => {
    expect(template([C({ weightBp: 6000 }), C({ code: 'TECH', weightBp: 4000 })]).success).toBe(
      true,
    );
    expect(template([C({ weightBp: 3000 })]).success).toBe(true);
    expect(template([C({ weightBp: 6000 }), C({ code: 'TECH', weightBp: 4001 })]).success).toBe(
      false,
    );
  });

  it('refuses a repeated code, an empty list, and one longer than the bound', () => {
    expect(template([C(), C()]).success).toBe(false);
    expect(template([]).success).toBe(false);
    const many = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) =>
      C({ code: `C${i}`, weightBp: 1 }),
    );
    expect(template(many).success).toBe(false);
  });

  it('carries no version: the next one is the server’s to give', () => {
    expect(
      createCriteriaTemplateSchema.safeParse({ label: 'Roads', criteria: [C()], version: 7 })
        .success,
    ).toBe(false);
  });
});

describe('setCriteriaSchema', () => {
  it('takes a template or a list, exactly one', () => {
    expect(setCriteriaSchema.safeParse({ expectedVersion: 1, templateId: 'CTP_1' }).success).toBe(
      true,
    );
    expect(setCriteriaSchema.safeParse({ expectedVersion: 1, criteria: [C()] }).success).toBe(true);
    expect(setCriteriaSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      setCriteriaSchema.safeParse({ expectedVersion: 1, templateId: 'CTP_1', criteria: [C()] })
        .success,
    ).toBe(false);
  });

  it('needs the version the tender is at', () => {
    expect(setCriteriaSchema.safeParse({ templateId: 'CTP_1' }).success).toBe(false);
    expect(setCriteriaSchema.safeParse({ expectedVersion: 0, templateId: 'CTP_1' }).success).toBe(
      false,
    );
  });

  it('filters templates by label and nothing else', () => {
    expect(listCriteriaTemplatesQuerySchema.safeParse({ label: 'Roads' }).success).toBe(true);
    expect(listCriteriaTemplatesQuerySchema.safeParse({ organizationId: 'O' }).success).toBe(false);
  });
});
