import {
  PARTICIPATION_FACTS,
  parseContributions,
  participationWindow,
  scoreParticipation,
  type ParticipationFactRow,
  type ParticipationRuleView,
} from './participation';
import {
  REWARD_TRIGGER_EVENTS,
  createParticipationRuleSchema,
  myParticipationQuerySchema,
} from './dto';
import { participationRuleChangedPayload } from '../events/events';

const AS_OF = new Date('2026-10-16T12:00:00.000Z');

const rule = (overrides: Partial<ParticipationRuleView> = {}): ParticipationRuleView => ({
  id: 'PRL_1',
  version: 3,
  windowDays: 30,
  contributions: [
    { triggerEvent: 'USAGE_RECORDED', weight: 2, maxPerWindow: 3 },
    { triggerEvent: 'MAINTENANCE_COMPLETED', weight: 5, maxPerWindow: null },
  ],
  label: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const fact = (
  triggerEvent: string,
  ordinal: number,
  occurredAt = '2026-10-15T00:00:00.000Z',
): ParticipationFactRow => ({
  triggerEvent,
  sourceReference: `${triggerEvent}-${ordinal}`,
  occurredAt: new Date(occurredAt),
  ordinal,
});

describe('participation score (ADR-047 § 1)', () => {
  it('has no score at all while no rule exists, rather than a zero', () => {
    expect(
      scoreParticipation({ rule: null, asOf: AS_OF, factCounts: new Map(), recentFacts: [] }),
    ).toEqual({ status: 'NO_RULE', asOf: AS_OF });
  });

  it('is the sum of its breakdown lines, each counted × weight, capped per window', () => {
    const result = scoreParticipation({
      rule: rule(),
      asOf: AS_OF,
      factCounts: new Map([
        ['USAGE_RECORDED', 5],
        ['MAINTENANCE_COMPLETED', 2],
      ]),
      recentFacts: [],
    });
    if (result.status !== 'SCORED') throw new Error('expected a score');
    expect(result.lines).toEqual([
      {
        triggerEvent: 'USAGE_RECORDED',
        weight: 2,
        maxPerWindow: 3,
        facts: 5,
        counted: 3,
        contribution: 6,
      },
      {
        triggerEvent: 'MAINTENANCE_COMPLETED',
        weight: 5,
        maxPerWindow: null,
        facts: 2,
        counted: 2,
        contribution: 10,
      },
    ]);
    expect(result.score).toBe(16);
    expect(result.score).toBe(result.lines.reduce((sum, line) => sum + line.contribution, 0));
    expect(result.rule.version).toBe(3);
  });

  it('shows a kind with no facts as a zero line, not a missing one', () => {
    const result = scoreParticipation({
      rule: rule(),
      asOf: AS_OF,
      factCounts: new Map(),
      recentFacts: [],
    });
    if (result.status !== 'SCORED') throw new Error('expected a score');
    expect(result.score).toBe(0);
    expect(result.lines.map((line) => [line.triggerEvent, line.facts, line.contribution])).toEqual([
      ['USAGE_RECORDED', 0, 0],
      ['MAINTENANCE_COMPLETED', 0, 0],
    ]);
  });

  it('says of each recent fact whether it counted and what it added: the earliest up to the cap', () => {
    const result = scoreParticipation({
      rule: rule(),
      asOf: AS_OF,
      factCounts: new Map([['USAGE_RECORDED', 4]]),
      recentFacts: [
        fact('USAGE_RECORDED', 4),
        fact('USAGE_RECORDED', 3),
        fact('MAINTENANCE_COMPLETED', 1),
      ],
    });
    if (result.status !== 'SCORED') throw new Error('expected a score');
    expect(result.recentFacts.map((f) => [f.sourceReference, f.counted, f.effect])).toEqual([
      ['USAGE_RECORDED-4', false, 0],
      ['USAGE_RECORDED-3', true, 2],
      ['MAINTENANCE_COMPLETED-1', true, 5],
    ]);
  });

  it('gives a fact of a kind the rule does not name no effect', () => {
    const result = scoreParticipation({
      rule: rule({
        contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1, maxPerWindow: null }],
      }),
      asOf: AS_OF,
      factCounts: new Map([['MAINTENANCE_COMPLETED', 9]]),
      recentFacts: [fact('MAINTENANCE_COMPLETED', 1)],
    });
    if (result.status !== 'SCORED') throw new Error('expected a score');
    expect(result.score).toBe(0);
    expect(result.recentFacts[0]).toMatchObject({ counted: false, effect: 0 });
  });

  it('scores over (asOf − windowDays, asOf]', () => {
    expect(participationWindow({ windowDays: 30 }, AS_OF)).toEqual({
      from: new Date('2026-09-16T12:00:00.000Z'),
      to: AS_OF,
    });
  });
});

describe('participation rule terms', () => {
  it('may count exactly the facts the reward consumer confirms', () => {
    expect([...PARTICIPATION_FACTS].sort()).toEqual([...REWARD_TRIGGER_EVENTS].sort());
  });

  const valid = {
    windowDays: 90,
    contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1, maxPerWindow: 60 }],
  };

  it('accepts a rule and invents no number for it', () => {
    const parsed = createParticipationRuleSchema.parse({
      windowDays: 7,
      contributions: [{ triggerEvent: 'MAINTENANCE_COMPLETED', weight: 3 }],
    });
    expect(parsed).toEqual({
      windowDays: 7,
      contributions: [{ triggerEvent: 'MAINTENANCE_COMPLETED', weight: 3 }],
    });
  });

  it.each([
    ['no window', { contributions: valid.contributions }],
    ['a window past a year', { ...valid, windowDays: 367 }],
    ['no contributions', { ...valid, contributions: [] }],
    [
      'a negative weight (a penalty)',
      { ...valid, contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: -1 }] },
    ],
    ['a zero weight', { ...valid, contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 0 }] }],
    [
      'a fractional weight',
      { ...valid, contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1.5 }] },
    ],
    [
      'a fact nobody confirms',
      { ...valid, contributions: [{ triggerEvent: 'USER_LOGGED_IN', weight: 1 }] },
    ],
    [
      'the same fact twice',
      {
        ...valid,
        contributions: [
          { triggerEvent: 'USAGE_RECORDED', weight: 1 },
          { triggerEvent: 'USAGE_RECORDED', weight: 2 },
        ],
      },
    ],
    ['an unknown field', { ...valid, organizationId: 'ORG-A' }],
  ])('refuses %s', (_label, body) => {
    expect(createParticipationRuleSchema.safeParse(body).success).toBe(false);
  });

  it('reads a stored rule back, and refuses one that no longer parses', () => {
    expect(parseContributions([{ triggerEvent: 'USAGE_RECORDED', weight: 2 }])).toEqual([
      { triggerEvent: 'USAGE_RECORDED', weight: 2, maxPerWindow: null },
    ]);
    for (const bad of [
      [],
      null,
      [{ triggerEvent: 'USAGE_RECORDED', weight: 0 }],
      [{ triggerEvent: 'CLICKED', weight: 1 }],
      [{ triggerEvent: 'USAGE_RECORDED', weight: 1, maxPerWindow: 0 }],
    ]) {
      expect(() => parseContributions(bad)).toThrow(/participation rule contribution/);
    }
  });

  it('takes no parameter that could name another user', () => {
    expect(myParticipationQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(myParticipationQuerySchema.safeParse({ userId: 'USR-OTHER' }).success).toBe(false);
  });

  it('records each new version against the one it replaced', () => {
    const terms = (version: number) => ({
      version,
      windowDays: 30,
      contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1, maxPerWindow: null }],
      label: null,
    });
    const base = {
      ruleId: 'PRL_2',
      change: 'CREATED',
      changedBy: 'USR-1',
      changedAt: AS_OF.toISOString(),
    };
    expect(
      participationRuleChangedPayload.safeParse({ ...base, before: null, after: terms(1) }).success,
    ).toBe(true);
    expect(
      participationRuleChangedPayload.safeParse({ ...base, before: terms(1), after: terms(2) })
        .success,
    ).toBe(true);
    expect(
      participationRuleChangedPayload.safeParse({ ...base, before: terms(1), after: terms(3) })
        .success,
    ).toBe(false);
    expect(
      participationRuleChangedPayload.safeParse({ ...base, before: null, after: terms(2) }).success,
    ).toBe(false);
    expect(
      participationRuleChangedPayload.safeParse({
        ...base,
        change: 'UPDATED',
        before: terms(1),
        after: terms(2),
      }).success,
    ).toBe(false);
  });
});
