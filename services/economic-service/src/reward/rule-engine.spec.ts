import {
  applicableRules,
  conditionMet,
  evaluate,
  isRefusal,
  levelFor,
  periodKeyFor,
  remainingCap,
  type RewardRuleView,
} from './rule-engine';

/**
 * The reward engine (docs/10 § 10.8, ADR-033).
 *
 * The property that matters most here is the one ADR-033 exists for:
 * **a rule with no `creditPerPointMinor` grants points and no money.** Nothing
 * in this file may produce a rial figure that did not come from configuration,
 * because docs/24 Q-09 — what share of commission funds rewards — is open.
 */

function rule(overrides: Partial<RewardRuleView> = {}): RewardRuleView {
  return {
    id: 'RWR_1',
    organizationId: null,
    triggerEvent: 'USAGE_RECORDED',
    rewardType: 'POINTS',
    condition: null,
    points: 10,
    creditPerPointMinor: null,
    periodCap: null,
    periodType: null,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

const AT = new Date('2026-06-15T12:00:00.000Z');

describe('applicableRules', () => {
  it('returns every matching rule, not only the most specific', () => {
    // Unlike commission. Two rules for one trigger are two separate
    // incentives; picking one would silently cancel the other. Two commission
    // rates on one transaction would be two charges for one service, which is
    // why that engine chooses.
    const rules = [
      rule({ id: 'GLOBAL', organizationId: null }),
      rule({ id: 'OWN', organizationId: 'ORG-A' }),
    ];
    expect(
      applicableRules(rules, 'ORG-A', 'USAGE_RECORDED', AT)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['GLOBAL', 'OWN']);
  });

  it('never returns another organization rule', () => {
    expect(
      applicableRules([rule({ organizationId: 'ORG-A' })], 'ORG-B', 'USAGE_RECORDED', AT),
    ).toEqual([]);
  });

  it('ignores a rule for a different trigger', () => {
    expect(
      applicableRules(
        [rule({ triggerEvent: 'MAINTENANCE_COMPLETED' })],
        'ORG-A',
        'USAGE_RECORDED',
        AT,
      ),
    ).toEqual([]);
  });

  it('ignores an INACTIVE rule', () => {
    expect(applicableRules([rule({ status: 'INACTIVE' })], 'ORG-A', 'USAGE_RECORDED', AT)).toEqual(
      [],
    );
  });

  it('applies the rule in force when the behaviour happened', () => {
    // A usage record submitted late earns what it would have earned when the
    // work was done, not what today's configuration says.
    const rules = [rule({ validTo: new Date('2026-03-01T00:00:00.000Z') })];
    expect(applicableRules(rules, 'ORG-A', 'USAGE_RECORDED', AT)).toEqual([]);
    expect(
      applicableRules(rules, 'ORG-A', 'USAGE_RECORDED', new Date('2026-02-01T00:00:00.000Z')),
    ).toHaveLength(1);
  });
});

describe('conditionMet', () => {
  const payload = { hours: '8.5', type: 'PREVENTIVE', downtimeMinutes: 120, scheduleId: null };

  it('treats an absent condition as always met', () => {
    expect(conditionMet(null, payload)).toBe(true);
    expect(conditionMet(undefined, payload)).toBe(true);
  });

  it('compares strings by equality', () => {
    expect(conditionMet({ field: 'type', op: 'eq', value: 'PREVENTIVE' }, payload)).toBe(true);
    expect(conditionMet({ field: 'type', op: 'eq', value: 'CORRECTIVE' }, payload)).toBe(false);
  });

  it('compares numeric strings numerically, not lexically', () => {
    // Quantities arrive as strings because they are NUMERIC at the source and
    // a JSON float would reintroduce the drift the column type prevents. "8.5"
    // is greater than "10" lexically and smaller numerically.
    expect(conditionMet({ field: 'hours', op: 'gte', value: '8' }, payload)).toBe(true);
    expect(conditionMet({ field: 'hours', op: 'gte', value: '10' }, payload)).toBe(false);
    expect(conditionMet({ field: 'hours', op: 'lt', value: '10' }, payload)).toBe(true);
  });

  it('handles presence and absence', () => {
    expect(conditionMet({ field: 'scheduleId', op: 'absent' }, payload)).toBe(true);
    expect(conditionMet({ field: 'type', op: 'present' }, payload)).toBe(true);
    expect(conditionMet({ field: 'missing', op: 'present' }, payload)).toBe(false);
  });

  it('combines with all and any', () => {
    expect(
      conditionMet(
        {
          all: [
            { field: 'type', op: 'eq', value: 'PREVENTIVE' },
            { field: 'hours', op: 'gte', value: '8' },
          ],
        },
        payload,
      ),
    ).toBe(true);

    expect(
      conditionMet(
        {
          any: [
            { field: 'type', op: 'eq', value: 'CORRECTIVE' },
            { field: 'hours', op: 'gte', value: '8' },
          ],
        },
        payload,
      ),
    ).toBe(true);
  });

  it('withholds the reward on a shape it does not understand', () => {
    // The safe direction. A mistyped condition granting to everybody would
    // move money; one granting to nobody shows up as a rule that never fires.
    expect(conditionMet({ nonsense: true }, payload)).toBe(false);
    expect(conditionMet('always', payload)).toBe(false);
    expect(conditionMet({ field: 'hours', op: 'matches', value: '.*' }, payload)).toBe(false);
  });

  it('withholds when a numeric comparison has nothing to compare', () => {
    expect(conditionMet({ field: 'type', op: 'gte', value: '5' }, payload)).toBe(false);
    expect(conditionMet({ field: 'missing', op: 'gte', value: '5' }, payload)).toBe(false);
  });
});

describe('periodKeyFor', () => {
  it('is UTC, so a day boundary cannot be crossed twice', () => {
    // A window that shifted with the viewer's calendar would let the same
    // behaviour be rewarded twice at midnight (AGENTS.md § 3).
    expect(periodKeyFor('DAY', new Date('2026-06-15T23:59:59.999Z'))).toBe('2026-06-15');
    expect(periodKeyFor('DAY', new Date('2026-06-16T00:00:00.000Z'))).toBe('2026-06-16');
  });

  it('produces a month key', () => {
    expect(periodKeyFor('MONTH', AT)).toBe('2026-06');
  });

  it('produces an ISO week key', () => {
    expect(periodKeyFor('WEEK', AT)).toMatch(/^2026-W\d{2}$/);
  });

  it('groups a whole ISO week under one key', () => {
    const monday = periodKeyFor('WEEK', new Date('2026-06-15T00:00:00.000Z'));
    const sunday = periodKeyFor('WEEK', new Date('2026-06-21T23:00:00.000Z'));
    expect(monday).toBe(sunday);
  });

  it('uses one key for an uncapped rule', () => {
    expect(periodKeyFor(null, AT)).toBe('ALL');
  });
});

describe('remainingCap', () => {
  it('is unbounded for an uncapped rule', () => {
    expect(remainingCap(rule(), 1_000_000)).toBeNull();
  });

  it('reports what is left', () => {
    expect(remainingCap(rule({ periodCap: 100, periodType: 'MONTH' }), 40)).toBe(60);
  });

  it('never goes negative', () => {
    expect(remainingCap(rule({ periodCap: 100, periodType: 'MONTH' }), 140)).toBe(0);
  });
});

describe('evaluate', () => {
  const payload = { hours: '8.5', type: 'PREVENTIVE' };

  it('grants points and no money when no conversion rate is configured', () => {
    // ADR-033, and the state every rule in this repository is in today.
    const decision = evaluate(rule(), payload, AT, 0);
    expect(isRefusal(decision)).toBe(false);
    expect(decision).toMatchObject({ points: 10, creditAmountMinor: 0n, monetised: false });
  });

  it('grants rial when a rate is configured', () => {
    const decision = evaluate(rule({ creditPerPointMinor: 1000n }), payload, AT, 0);
    expect(decision).toMatchObject({ points: 10, creditAmountMinor: 10_000n, monetised: true });
  });

  it('refuses when the condition is not met', () => {
    const decision = evaluate(
      rule({ condition: { field: 'type', op: 'eq', value: 'CORRECTIVE' } }),
      payload,
      AT,
      0,
    );
    expect(decision).toEqual({ reason: 'condition_unmet', ruleId: 'RWR_1' });
  });

  it('refuses once the cap is exhausted', () => {
    const decision = evaluate(rule({ periodCap: 20, periodType: 'MONTH' }), payload, AT, 20);
    expect(decision).toEqual({ reason: 'cap_reached', ruleId: 'RWR_1', capped: 20 });
  });

  it('grants a partial amount at the edge of the cap', () => {
    // Deliberate. Granting nothing would make the cap a cliff that discards
    // earned behaviour; granting the full amount would make it decorative —
    // and the cap is an anti-fraud control (docs/10 § 10.9).
    const decision = evaluate(
      rule({ points: 10, periodCap: 15, periodType: 'MONTH' }),
      payload,
      AT,
      12,
    );
    expect(decision).toMatchObject({ points: 3 });
  });

  it('prices a partial grant proportionally rather than at full rate', () => {
    const decision = evaluate(
      rule({ points: 10, creditPerPointMinor: 1000n, periodCap: 15, periodType: 'MONTH' }),
      payload,
      AT,
      12,
    );
    expect(decision).toMatchObject({ points: 3, creditAmountMinor: 3000n, monetised: true });
  });

  it('stamps the grant with the window it counted against', () => {
    const decision = evaluate(rule({ periodCap: 100, periodType: 'MONTH' }), payload, AT, 0);
    expect(decision).toMatchObject({ periodKey: '2026-06' });
  });
});

describe('levelFor', () => {
  const levels = [
    { id: 'L0', name: 'پایه', minPoints: 0, rank: 0, status: 'ACTIVE' },
    { id: 'L1', name: 'نقره‌ای', minPoints: 100, rank: 1, status: 'ACTIVE' },
    { id: 'L2', name: 'طلایی', minPoints: 500, rank: 2, status: 'ACTIVE' },
  ];

  it('returns null when no ladder is configured', () => {
    // The MVP's state: docs/24 Q-13 asks what a higher level actually gets,
    // and it has not been answered, so nothing is granted.
    expect(levelFor([], 900)).toBeNull();
  });

  it('returns the highest level reached', () => {
    expect(levelFor(levels, 750)?.id).toBe('L2');
    expect(levelFor(levels, 100)?.id).toBe('L1');
    expect(levelFor(levels, 99)?.id).toBe('L0');
  });

  it('ignores an inactive level', () => {
    const withRetired = [
      ...levels,
      { id: 'L3', name: 'x', minPoints: 600, rank: 3, status: 'INACTIVE' },
    ];
    expect(levelFor(withRetired, 900)?.id).toBe('L2');
  });

  it('returns null when the total reaches no threshold', () => {
    expect(
      levelFor([{ id: 'L1', name: 'x', minPoints: 100, rank: 1, status: 'ACTIVE' }], 50),
    ).toBeNull();
  });
});
