import {
  RECOGNITION_BASES,
  levelsAreLadder,
  parseRecognitionTerms,
  recognise,
  type RecognitionRuleView,
} from './recognition';
import { createRecognitionRuleSchema, myRecognitionQuerySchema } from './dto';
import { toRecognitionView } from './recognition-views';
import { recognitionRuleChangedPayload } from '../events/events';

const AS_OF = new Date('2026-10-17T12:00:00.000Z');

const rule = (overrides: Partial<RecognitionRuleView> = {}): RecognitionRuleView => ({
  id: 'RCR_1',
  version: 2,
  basis: 'REWARD_POINTS_CUMULATIVE',
  levels: [
    { rank: 1, name: 'L1', threshold: 0 },
    { rank: 2, name: 'L2', threshold: 100 },
    { rank: 3, name: 'L3', threshold: 500 },
  ],
  badges: [
    { code: 'B_TEN', name: 'B10', threshold: 10 },
    { code: 'B_THOUSAND', name: 'B1000', threshold: 1000 },
  ],
  label: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const points = (value: number) => ({ basis: 'REWARD_POINTS_CUMULATIVE' as const, value });

describe('recognise', () => {
  it('says NO_RULE while no version exists, rather than a level nobody configured', () => {
    expect(recognise({ rule: null, asOf: AS_OF, basis: null })).toEqual({
      status: 'NO_RULE',
      asOf: AS_OF,
    });
  });

  it('holds the highest level whose threshold the value meets, thresholds inclusive', () => {
    const at = (value: number) => {
      const result = recognise({ rule: rule(), asOf: AS_OF, basis: points(value) });
      return result.status === 'EVALUATED' ? result.level?.rank : undefined;
    };
    expect(at(0)).toBe(1);
    expect(at(99)).toBe(1);
    expect(at(100)).toBe(2);
    expect(at(499)).toBe(2);
    expect(at(500)).toBe(3);
    expect(at(1_000_000)).toBe(3);
  });

  it('holds no level below the lowest threshold', () => {
    const result = recognise({
      rule: rule({ levels: [{ rank: 1, name: 'L1', threshold: 50 }] }),
      asOf: AS_OF,
      basis: points(49),
    });
    expect(result).toMatchObject({ status: 'EVALUATED', level: null });
  });

  it('holds every badge whose threshold the value meets, and only those', () => {
    const held = (value: number) => {
      const result = recognise({ rule: rule(), asOf: AS_OF, basis: points(value) });
      return result.status === 'EVALUATED' ? result.badges.map((badge) => badge.code) : undefined;
    };
    expect(held(9)).toEqual([]);
    expect(held(10)).toEqual(['B_TEN']);
    expect(held(1000)).toEqual(['B_TEN', 'B_THOUSAND']);
  });

  it('reads a participation-score version on the score, and says NO_BASIS when there is none', () => {
    const scored = rule({ basis: 'PARTICIPATION_SCORE' });
    expect(
      recognise({
        rule: scored,
        asOf: AS_OF,
        basis: { basis: 'PARTICIPATION_SCORE', value: 120, participationRuleVersion: 4 },
      }),
    ).toMatchObject({ status: 'EVALUATED', level: { rank: 2 }, badges: [{ code: 'B_TEN' }] });
    expect(
      recognise({
        rule: scored,
        asOf: AS_OF,
        basis: { basis: 'PARTICIPATION_SCORE', value: null, participationRuleVersion: null },
      }),
    ).toMatchObject({ status: 'NO_BASIS' });
  });

  it('refuses to read a version on a basis other than the one it names', () => {
    // The basis is the version's: reading points against a score ladder would
    // be the code choosing it.
    expect(() =>
      recognise({ rule: rule({ basis: 'PARTICIPATION_SCORE' }), asOf: AS_OF, basis: points(5) }),
    ).toThrow(/read on PARTICIPATION_SCORE/);
  });
});

describe('the caller view', () => {
  it('carries what is held and why, never the levels above or the badges not held', () => {
    const view = toRecognitionView({
      organizationId: 'ORG-1',
      userId: 'USR-1',
      recognition: recognise({ rule: rule(), asOf: AS_OF, basis: points(150) }),
    });
    expect(view).toEqual({
      organizationId: 'ORG-1',
      userId: 'USR-1',
      status: 'EVALUATED',
      asOf: AS_OF.toISOString(),
      rule: {
        id: 'RCR_1',
        version: 2,
        basis: 'REWARD_POINTS_CUMULATIVE',
        label: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      basis: { kind: 'REWARD_POINTS_CUMULATIVE', value: 150, participationRuleVersion: null },
      level: { rank: 2, name: 'L2', threshold: 100 },
      badges: [{ code: 'B_TEN', name: 'B10', threshold: 10 }],
    });
    // No coercive mechanics (docs/10 § 10.8): nothing from which a client
    // could render "N to the next level".
    const text = JSON.stringify(view);
    expect(text).not.toContain('L3');
    expect(text).not.toContain('B_THOUSAND');
    expect(text).not.toMatch(/next|remaining|streak|progress|benefit/i);
  });

  it('has no level and no badges, and null rule and basis, under NO_RULE', () => {
    expect(
      toRecognitionView({
        organizationId: 'ORG-1',
        userId: 'USR-1',
        recognition: recognise({ rule: null, asOf: AS_OF, basis: null }),
      }),
    ).toMatchObject({ status: 'NO_RULE', rule: null, basis: null, level: null, badges: [] });
  });

  it('names the participation rule version the score was read under', () => {
    const view = toRecognitionView({
      organizationId: 'ORG-1',
      userId: 'USR-1',
      recognition: recognise({
        rule: rule({ basis: 'PARTICIPATION_SCORE' }),
        asOf: AS_OF,
        basis: { basis: 'PARTICIPATION_SCORE', value: 0, participationRuleVersion: 7 },
      }),
    });
    expect(view.basis).toEqual({
      kind: 'PARTICIPATION_SCORE',
      value: 0,
      participationRuleVersion: 7,
    });
    expect(view.level).toMatchObject({ rank: 1 });
  });
});

describe('a new version', () => {
  const valid = {
    expectedCurrentVersion: 0,
    basis: 'PARTICIPATION_SCORE',
    levels: [
      { name: 'L1', threshold: 0 },
      { name: 'L2', threshold: 10 },
    ],
    badges: [{ code: 'FIRST_REPAIR', name: 'B', threshold: 5 }],
  };

  it('states the version it replaces, never assumed (review of #328, r1)', () => {
    const { expectedCurrentVersion: _expected, ...withoutExpected } = valid;
    for (const body of [
      withoutExpected,
      { ...valid, expectedCurrentVersion: -1 },
      { ...valid, expectedCurrentVersion: 1.5 },
    ]) {
      expect(createRecognitionRuleSchema.safeParse(body).success).toBe(false);
    }
    expect(
      createRecognitionRuleSchema.parse({ ...valid, expectedCurrentVersion: 3 }),
    ).toMatchObject({ expectedCurrentVersion: 3 });
  });

  it('accepts exactly the two bases, and has no default for it', () => {
    expect([...RECOGNITION_BASES]).toEqual(['REWARD_POINTS_CUMULATIVE', 'PARTICIPATION_SCORE']);
    expect(createRecognitionRuleSchema.safeParse(valid).success).toBe(true);
    const { basis: _basis, ...withoutBasis } = valid;
    expect(createRecognitionRuleSchema.safeParse(withoutBasis).success).toBe(false);
    expect(createRecognitionRuleSchema.safeParse({ ...valid, basis: 'LOGINS' }).success).toBe(
      false,
    );
  });

  it('refuses thresholds that do not rise strictly, lowest level first', () => {
    for (const levels of [
      [
        { name: 'L1', threshold: 10 },
        { name: 'L2', threshold: 10 },
      ],
      [
        { name: 'L1', threshold: 10 },
        { name: 'L2', threshold: 0 },
      ],
    ]) {
      expect(createRecognitionRuleSchema.safeParse({ ...valid, levels }).success).toBe(false);
    }
  });

  it('refuses negative or fractional thresholds, blank names and repeated names or codes', () => {
    const refused = [
      { ...valid, levels: [{ name: 'L1', threshold: -1 }] },
      { ...valid, levels: [{ name: 'L1', threshold: 1.5 }] },
      { ...valid, levels: [{ name: '  ', threshold: 0 }] },
      {
        ...valid,
        levels: [
          { name: 'L1', threshold: 0 },
          { name: 'L1', threshold: 5 },
        ],
      },
      {
        ...valid,
        badges: [
          { code: 'SAME', name: 'a', threshold: 1 },
          { code: 'SAME', name: 'b', threshold: 2 },
        ],
      },
      { ...valid, badges: [{ code: 'lower-case', name: 'b', threshold: 1 }] },
    ];
    for (const dto of refused) {
      expect(createRecognitionRuleSchema.safeParse(dto).success).toBe(false);
    }
  });

  it('refuses a version that names neither a level nor a badge', () => {
    expect(
      createRecognitionRuleSchema.safeParse({ ...valid, levels: [], badges: [] }).success,
    ).toBe(false);
    expect(createRecognitionRuleSchema.safeParse({ ...valid, levels: [] }).success).toBe(true);
    expect(createRecognitionRuleSchema.safeParse({ ...valid, badges: [] }).success).toBe(true);
  });

  it('has no field for a rank, a benefit, a streak or anything else it was not given', () => {
    // Ranks are the order; benefits are docs/24 Q-13 and Q-31.
    for (const extra of [
      { benefits: ['PRIORITY_SUPPORT'] },
      { streakDays: 7 },
      { organizationId: 'ORG-1' },
    ]) {
      expect(createRecognitionRuleSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    expect(
      createRecognitionRuleSchema.safeParse({
        ...valid,
        levels: [{ name: 'L1', threshold: 0, rank: 5 }],
      }).success,
    ).toBe(false);
  });
});

describe('the caller query', () => {
  it('takes nothing: naming a user or an organization is refused', () => {
    expect(myRecognitionQuerySchema.safeParse({}).success).toBe(true);
    expect(myRecognitionQuerySchema.safeParse({ userId: 'USR-2' }).success).toBe(false);
    expect(myRecognitionQuerySchema.safeParse({ organizationId: 'ORG-2' }).success).toBe(false);
  });
});

describe('a stored version, read back', () => {
  const stored = {
    basis: 'REWARD_POINTS_CUMULATIVE',
    levels: [
      { rank: 1, name: 'L1', threshold: 0 },
      { rank: 2, name: 'L2', threshold: 5 },
    ],
    badges: [{ code: 'B1', name: 'B', threshold: 3 }],
  };

  it('parses what the service wrote', () => {
    expect(parseRecognitionTerms(stored)).toEqual(stored);
  });

  it('refuses a row that no longer parses, rather than reading another ladder', () => {
    for (const row of [
      { ...stored, basis: 'LOGINS' },
      { ...stored, levels: {} },
      { ...stored, levels: [], badges: [] },
      { ...stored, levels: [{ rank: 2, name: 'L1', threshold: 0 }] },
      {
        ...stored,
        levels: [
          { rank: 1, name: 'L1', threshold: 5 },
          { rank: 2, name: 'L2', threshold: 5 },
        ],
      },
      { ...stored, badges: [{ code: 'B1', name: 'B', threshold: -1 }] },
      {
        ...stored,
        badges: [
          { code: 'B1', name: 'B', threshold: 1 },
          { code: 'B1', name: 'C', threshold: 2 },
        ],
      },
    ]) {
      expect(() => parseRecognitionTerms(row)).toThrow();
    }
  });

  it('treats an empty ladder as a ladder', () => {
    expect(levelsAreLadder([])).toBe(true);
  });
});

describe('RECOGNITION_RULE_CHANGED', () => {
  const terms = (version: number) => ({
    version,
    basis: 'REWARD_POINTS_CUMULATIVE' as const,
    levels: [{ rank: 1, name: 'L1', threshold: 0 }],
    badges: [],
    label: null,
  });
  const event = (before: ReturnType<typeof terms> | null, after: ReturnType<typeof terms>) => ({
    ruleId: 'RCR_1',
    change: 'CREATED',
    changedBy: 'USR-ADMIN',
    changedAt: AS_OF.toISOString(),
    before,
    after,
  });

  it('carries the terms before and after, the after being the next version', () => {
    expect(recognitionRuleChangedPayload.safeParse(event(null, terms(1))).success).toBe(true);
    expect(recognitionRuleChangedPayload.safeParse(event(terms(1), terms(2))).success).toBe(true);
    expect(recognitionRuleChangedPayload.safeParse(event(terms(1), terms(3))).success).toBe(false);
    expect(recognitionRuleChangedPayload.safeParse(event(null, terms(2))).success).toBe(false);
  });
});
