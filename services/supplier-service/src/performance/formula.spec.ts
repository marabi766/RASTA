import { RastaError } from '@rasta/nest-common';
import { PERFORMANCE_COMPONENTS, WEIGHT_TOTAL_BP } from './components';
import {
  assertActivatable,
  assertValidFormulaDraft,
  formulaDraftProblems,
  type FormulaDraftInput,
} from './formula';

/**
 * Domain validation of a formula draft (ADR-052 § 3, § 7).
 *
 * The fixture is ADR-052 § 1's accepted first version. It is a fixture here —
 * never a default in the code under test.
 */
const ADR_052_V1: FormulaDraftInput = {
  windowDays: 180,
  minSampleCount: 5,
  minCoverageBp: 5000,
  ratingMapping: { scaleMin: 1, scaleMax: 5, minScoreCentis: 0, maxScoreCentis: 10_000 },
  weights: [
    { component: 'QUALITY', weightBp: 3000 },
    { component: 'ON_TIME', weightBp: 2500 },
    { component: 'CUSTOMER_SATISFACTION', weightBp: 2000 },
    { component: 'DISPUTE_ABSENCE', weightBp: 1500 },
    { component: 'CANCELLATION_ABSENCE', weightBp: 1000 },
  ],
};

function withWeights(weights: FormulaDraftInput['weights']): FormulaDraftInput {
  return { ...ADR_052_V1, weights };
}

function paths(input: FormulaDraftInput): string[] {
  return formulaDraftProblems(input).map((problem) => problem.path);
}

describe('a valid draft', () => {
  it('accepts ADR-052 § 1 exactly as accepted', () => {
    expect(formulaDraftProblems(ADR_052_V1)).toEqual([]);
    expect(() => assertValidFormulaDraft(ADR_052_V1)).not.toThrow();
  });

  it('accepts a version that weighs only some components', () => {
    expect(
      formulaDraftProblems(
        withWeights([
          { component: 'CUSTOMER_SATISFACTION', weightBp: 4000 },
          { component: 'QUALITY', weightBp: 6000 },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('the 100% rule (ADR-052 § 3)', () => {
  it.each([
    ['one basis point short', 999],
    ['one basis point over', 1001],
  ])('refuses weights %s', (_label, cancellation) => {
    const weights = ADR_052_V1.weights.map((weight) =>
      weight.component === 'CANCELLATION_ABSENCE' ? { ...weight, weightBp: cancellation } : weight,
    );

    expect(paths(withWeights(weights))).toEqual(['weights']);
  });

  it('refuses a version with no weights at all', () => {
    expect(paths(withWeights([]))).toEqual(['weights']);
  });

  it('names the sum it found', () => {
    const [problem] = formulaDraftProblems(withWeights([{ component: 'QUALITY', weightBp: 9999 }]));

    expect(problem?.message).toContain('9999');
    expect(problem?.message).toContain(String(WEIGHT_TOTAL_BP));
  });
});

describe('each weight', () => {
  it('refuses a zero weight — a component not weighed has no row', () => {
    expect(
      paths(
        withWeights([
          { component: 'QUALITY', weightBp: 10_000 },
          { component: 'ON_TIME', weightBp: 0 },
        ]),
      ),
    ).toContain('weights[1].weightBp');
  });

  it('refuses a fractional basis point — no float anywhere', () => {
    expect(
      paths(
        withWeights([
          { component: 'QUALITY', weightBp: 5000.5 },
          { component: 'ON_TIME', weightBp: 4999.5 },
        ]),
      ),
    ).toEqual(expect.arrayContaining(['weights[0].weightBp', 'weights[1].weightBp']));
  });

  it('refuses the same component weighed twice', () => {
    expect(
      paths(
        withWeights([
          { component: 'QUALITY', weightBp: 5000 },
          { component: 'QUALITY', weightBp: 5000 },
        ]),
      ),
    ).toEqual(['weights[1].component']);
  });

  it('refuses a component ADR-052 did not accept', () => {
    const weights = [
      { component: 'PRICE' as never, weightBp: 5000 },
      { component: 'QUALITY' as const, weightBp: 5000 },
    ];

    expect(paths(withWeights(weights))).toEqual(['weights[0].component']);
  });

  it('knows exactly the five accepted components', () => {
    expect([...PERFORMANCE_COMPONENTS].sort()).toEqual([
      'CANCELLATION_ABSENCE',
      'CUSTOMER_SATISFACTION',
      'DISPUTE_ABSENCE',
      'ON_TIME',
      'QUALITY',
    ]);
  });
});

describe('window, thresholds and the rating mapping', () => {
  it.each([
    ['windowDays', { windowDays: 0 }],
    ['windowDays', { windowDays: 30.5 }],
    ['minSampleCount', { minSampleCount: 0 }],
    ['minCoverageBp', { minCoverageBp: -1 }],
    ['minCoverageBp', { minCoverageBp: 10_001 }],
  ] as const)('refuses an invalid %s', (path, patch) => {
    expect(paths({ ...ADR_052_V1, ...patch })).toEqual([path]);
  });

  it('refuses a rating scale whose ends are equal or reversed', () => {
    expect(
      paths({ ...ADR_052_V1, ratingMapping: { ...ADR_052_V1.ratingMapping, scaleMin: 5 } }),
    ).toEqual(['ratingMapping']);
  });

  it('refuses a mapping where a better rating scores lower', () => {
    expect(
      paths({
        ...ADR_052_V1,
        ratingMapping: { scaleMin: 1, scaleMax: 5, minScoreCentis: 10_000, maxScoreCentis: 0 },
      }),
    ).toEqual(['ratingMapping']);
  });

  it('refuses a mapped score outside 0..100', () => {
    expect(
      paths({
        ...ADR_052_V1,
        ratingMapping: { ...ADR_052_V1.ratingMapping, maxScoreCentis: 10_001 },
      }),
    ).toEqual(['ratingMapping.maxScoreCentis']);
  });
});

describe('the refusal', () => {
  it('reports every problem at once, as VALIDATION_FAILED', () => {
    const bad: FormulaDraftInput = { ...withWeights([]), windowDays: 0, minSampleCount: 0 };

    expect(() => assertValidFormulaDraft(bad)).toThrow(RastaError);
    try {
      assertValidFormulaDraft(bad);
    } catch (error) {
      expect((error as RastaError).code).toBe('VALIDATION_FAILED');
      expect(formulaDraftProblems(bad)).toHaveLength(3);
    }
  });
});

describe('activation', () => {
  it('activates a DRAFT', () => {
    expect(() => assertActivatable(3, 'DRAFT')).not.toThrow();
  });

  it.each(['ACTIVE', 'RETIRED'] as const)('never re-activates a %s version', (status) => {
    expect(() => assertActivatable(3, status)).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });
});
