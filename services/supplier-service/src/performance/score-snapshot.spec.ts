import {
  assertValidScoreSnapshot,
  effectiveWeightBp,
  formatScoreCentis,
  scoreSnapshotProblems,
  type ScoreSnapshotInput,
} from './score-snapshot';

/**
 * Snapshot provenance rules (ADR-052 § 5, § 7, § 8).
 *
 * The fixture is ADR-052's own worked example: only satisfaction (20%) and
 * one other available — here the three components with producers, 70%.
 */

const PUBLISHED: ScoreSnapshotInput = {
  organizationId: 'ORG_SUPPLIER',
  formulaVersionId: 'PFV_1',
  formulaVersion: 1,
  windowStart: new Date('2026-03-30T00:00:00.000Z'),
  windowEnd: new Date('2026-09-26T00:00:00.000Z'),
  status: 'PUBLISHED',
  scoreCentis: 8750,
  eligibleSampleCount: 7,
  coverageBp: 7000,
  components: [
    {
      component: 'QUALITY',
      configuredWeightBp: 3000,
      effectiveWeightBp: null,
      componentScoreCentis: null,
      sampleCount: 0,
    },
    {
      component: 'ON_TIME',
      configuredWeightBp: 2500,
      effectiveWeightBp: 3571,
      componentScoreCentis: 9000,
      sampleCount: 7,
    },
    {
      component: 'CUSTOMER_SATISFACTION',
      configuredWeightBp: 2000,
      effectiveWeightBp: 2857,
      componentScoreCentis: 8000,
      sampleCount: 6,
    },
    {
      component: 'DISPUTE_ABSENCE',
      configuredWeightBp: 1500,
      effectiveWeightBp: 2143,
      componentScoreCentis: 10000,
      sampleCount: 2,
    },
    {
      component: 'CANCELLATION_ABSENCE',
      configuredWeightBp: 1000,
      effectiveWeightBp: 1429,
      componentScoreCentis: 10000,
      sampleCount: 1,
    },
  ],
  sourceEventIds: ['EVT_1', 'EVT_2'],
  correlationId: 'COR_1',
};

function paths(input: ScoreSnapshotInput): string[] {
  return scoreSnapshotProblems(input).map((problem) => problem.path);
}

describe('effective weight — exact pair stored, half-up for display', () => {
  it('renormalises ADR-052 § 5’s example exactly: 20% and 30% become 40% and 60%', () => {
    expect(effectiveWeightBp(2000, 5000)).toBe(4000);
    expect(effectiveWeightBp(3000, 5000)).toBe(6000);
  });

  it('rounds half up, in integers', () => {
    // 2000 / 7000 = 0.285714… → 2857.14 bp → 2857; 1000 / 7000 → 1428.57 → 1429.
    expect(effectiveWeightBp(2000, 7000)).toBe(2857);
    expect(effectiveWeightBp(1000, 7000)).toBe(1429);
    // An exact .5 goes up: 1 / 20000 of 10 000 is 0.5 bp.
    expect(effectiveWeightBp(1, 20_000)).toBe(1);
  });

  it('does not force the rounded weights to sum to 10 000', () => {
    const rounded = [2500, 2000, 1500, 1000].map((w) => effectiveWeightBp(w, 7000));

    expect(rounded.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect([1, 1, 1].map((w) => effectiveWeightBp(w, 3)).reduce((a, b) => a + b, 0)).toBe(9999);
  });

  it('refuses to renormalise over no coverage', () => {
    expect(() => effectiveWeightBp(1000, 0)).toThrow(RangeError);
  });
});

describe('a score leaves as a two-decimal string (ADR-052 § 7)', () => {
  it.each([
    [8750, '87.50'],
    [0, '0.00'],
    [10_000, '100.00'],
    [5, '0.05'],
  ])('formats %s as %s', (centis, text) => {
    expect(formatScoreCentis(centis)).toBe(text);
  });

  it.each([-1, 10_001, 87.5])('refuses %s', (centis) => {
    expect(() => formatScoreCentis(centis)).toThrow(RangeError);
  });
});

describe('a valid snapshot', () => {
  it('accepts a PUBLISHED snapshot with an absent QUALITY component', () => {
    expect(scoreSnapshotProblems(PUBLISHED)).toEqual([]);
  });

  it('accepts INSUFFICIENT_DATA with no score but its sample count', () => {
    expect(
      scoreSnapshotProblems({
        ...PUBLISHED,
        status: 'INSUFFICIENT_DATA',
        scoreCentis: null,
        eligibleSampleCount: 4,
      }),
    ).toEqual([]);
  });

  it('accepts INSUFFICIENT_COVERAGE with nothing available', () => {
    const components = PUBLISHED.components.map((row) => ({
      ...row,
      effectiveWeightBp: null,
      componentScoreCentis: null,
    }));

    expect(
      scoreSnapshotProblems({
        ...PUBLISHED,
        status: 'INSUFFICIENT_COVERAGE',
        scoreCentis: null,
        coverageBp: 0,
        components,
      }),
    ).toEqual([]);
  });
});

describe('the score exists only when PUBLISHED', () => {
  it('refuses PUBLISHED without a score', () => {
    expect(paths({ ...PUBLISHED, scoreCentis: null })).toEqual(['scoreCentis']);
  });

  it.each(['INSUFFICIENT_DATA', 'INSUFFICIENT_COVERAGE'] as const)(
    'refuses a score — even 0 — on %s',
    (status) => {
      expect(paths({ ...PUBLISHED, status, scoreCentis: 0 })).toContain('scoreCentis');
    },
  );

  it.each([10_001, -1, 87.5])('refuses a score of %s — integers only, no float', (scoreCentis) => {
    expect(paths({ ...PUBLISHED, scoreCentis })).toEqual(['scoreCentis']);
  });
});

describe('absent is NULL, never 0 (ADR-052 § 5)', () => {
  it('refuses a component with a weight and no score', () => {
    const components = PUBLISHED.components.map((row, i) =>
      i === 0 ? { ...row, effectiveWeightBp: 1 } : row,
    );

    expect(paths({ ...PUBLISHED, components })).toContain('components[0]');
  });

  it('refuses a coverage that is not the configured weight of the available components', () => {
    expect(paths({ ...PUBLISHED, coverageBp: 10_000 })).toContain('coverageBp');
  });

  it('refuses an effective weight that is not the renormalised configured weight', () => {
    const components = PUBLISHED.components.map((row, i) =>
      i === 1 ? { ...row, effectiveWeightBp: 2500 } : row,
    );

    expect(paths({ ...PUBLISHED, components })).toEqual(['components[1].effectiveWeightBp']);
  });

  it('refuses PUBLISHED resting on no available component', () => {
    const components = PUBLISHED.components.map((row) => ({
      ...row,
      effectiveWeightBp: null,
      componentScoreCentis: null,
    }));

    expect(paths({ ...PUBLISHED, components, coverageBp: 0 })).toEqual(['status']);
  });
});

describe('a present component counted something', () => {
  it('refuses a score resting on zero samples', () => {
    const components = PUBLISHED.components.map((row, i) =>
      i === 1 ? { ...row, sampleCount: 0 } : row,
    );

    expect(paths({ ...PUBLISHED, components })).toEqual(['components[1].sampleCount']);
  });

  it('allows an absent component to have counted facts it excluded', () => {
    const components = PUBLISHED.components.map((row, i) =>
      i === 0 ? { ...row, sampleCount: 2 } : row,
    );

    expect(paths({ ...PUBLISHED, components })).toEqual([]);
  });
});

describe('shape', () => {
  it('refuses an empty window', () => {
    expect(paths({ ...PUBLISHED, windowEnd: PUBLISHED.windowStart })).toEqual(['windowStart']);
  });

  it('refuses a component listed twice, and a source event cited twice', () => {
    const components = [...PUBLISHED.components, PUBLISHED.components[0]!];

    expect(paths({ ...PUBLISHED, components, sourceEventIds: ['E', 'E'] })).toEqual(
      expect.arrayContaining(['components[5].component', 'sourceEventIds']),
    );
  });

  it('throws VALIDATION_FAILED', () => {
    expect(() => assertValidScoreSnapshot({ ...PUBLISHED, scoreCentis: null })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
