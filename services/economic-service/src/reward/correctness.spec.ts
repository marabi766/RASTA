import { conditionMet, periodKeyFor, applicableRules, type RewardRuleView } from './rule-engine';
import { canonicalCondition, createRewardRuleSchema } from './dto';
import { NUMERIC_FACT_TYPES } from './exact-comparison';

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;

describe('exact reward predicates (F5)', () => {
  it.each(Object.keys(NUMERIC_FACT_TYPES).flatMap((field) => OPS.map((op) => [field, op])))(
    '%s %s distinguishes adjacent values beyond 2^53',
    (field, op) => {
      const value = '9007199254740993';
      const actual = '9007199254740992';
      expect(conditionMet({ field, op, value }, { [field!]: actual })).toBe(
        ['neq', 'lt', 'lte'].includes(op!),
      );
    },
  );

  it.each(
    ['hours', 'kilometres', 'hourMeter', 'odometer'].flatMap((field) =>
      OPS.map((op) => [field, op]),
    ),
  )('%s %s distinguishes arbitrarily small fractions', (field, op) => {
    expect(
      conditionMet(
        { field, op, value: '7.500000000000000002' },
        { [field!]: '7.500000000000000001' },
      ),
    ).toBe(['neq', 'lt', 'lte'].includes(op!));
  });

  it.each(OPS)('%s refuses invalid, null, missing and unsafe operands', (op) => {
    for (const invalid of [
      null,
      undefined,
      '',
      ' ',
      '0x10',
      '1e3',
      'NaN',
      '1'.repeat(257),
      true,
      {},
      Number.MAX_SAFE_INTEGER + 1,
      1.1,
    ]) {
      expect(conditionMet({ field: 'hours', op, value: invalid }, { hours: '8' })).toBe(false);
      expect(conditionMet({ field: 'hours', op, value: '8' }, { hours: invalid })).toBe(false);
    }
    expect(
      conditionMet({ field: 'totalCostMinor', op, value: '8.5' }, { totalCostMinor: '8' }),
    ).toBe(false);
  });

  it('compares numeric equality by value and retains string equality and presence', () => {
    expect(conditionMet({ field: 'hours', op: 'eq', value: '7.50' }, { hours: '7.5' })).toBe(true);
    expect(conditionMet({ field: 'hours', op: 'neq', value: '7.50' }, { hours: '7.5' })).toBe(
      false,
    );
    expect(conditionMet({ field: 'type', op: 'eq', value: '7.50' }, { type: '7.5' })).toBe(false);
    expect(conditionMet({ field: 'type', op: 'neq', value: 'PREVENTIVE' }, {})).toBe(false);
    expect(conditionMet({ field: 'hours', op: 'absent' }, { hours: null })).toBe(true);
    expect(
      conditionMet(
        {
          all: [
            { field: 'hours', op: 'gte', value: '7.5' },
            { any: [{ field: 'hours', op: 'lt', value: '8' }] },
          ],
        },
        { hours: '7.50' },
      ),
    ).toBe(true);
    expect(conditionMet({ field: 'hours', op: 'gt', value: '-0.02' }, { hours: '-.01' })).toBe(
      true,
    );
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    JSON.parse('9007199254740993') as number,
    JSON.parse('9007199254740991.1') as number,
    7,
    1.0000000000000002,
    0.1,
  ])('refuses a JSON number with unrecoverable precision at rule creation: %s', (value) => {
    const result = createRewardRuleSchema.safeParse({
      triggerEvent: 'USAGE_RECORDED',
      points: 1,
      condition: { all: [{ field: 'hours', op: 'gte', value }] },
    });
    expect(result.success).toBe(false);
  });

  it('canonicalization cannot turn invalid minor-unit grammar into a granting predicate', () => {
    const condition = { field: 'totalCostMinor', op: 'gte', value: '1.0' };
    expect(canonicalCondition(condition)).toEqual(condition);
    expect(conditionMet(canonicalCondition(condition), { totalCostMinor: '2' })).toBe(false);
  });

  it('uses the DTO-trimmed field type before numeric canonicalization', () => {
    const condition = { field: ' totalCostMinor ', op: 'gte', value: '1.0' };
    const parsed = createRewardRuleSchema.parse({
      triggerEvent: 'MAINTENANCE_COMPLETED',
      points: 1,
      condition: canonicalCondition(condition),
    });
    expect(parsed.condition).toEqual({ field: 'totalCostMinor', op: 'gte', value: '1.0' });
    expect(conditionMet(parsed.condition, { totalCostMinor: '2' })).toBe(false);
    expect(canonicalCondition({ field: ' hours ', op: 'eq', value: '07.50' })).toMatchObject({
      value: '7.5',
    });
  });

  it('accepts exact integer and decimal strings', () => {
    for (const value of ['7', '9007199254740993', '0.100000000000000001']) {
      expect(
        createRewardRuleSchema.safeParse({
          triggerEvent: 'USAGE_RECORDED',
          points: 1,
          condition: { field: 'hours', op: 'eq', value },
        }).success,
      ).toBe(true);
    }
  });
});

describe('UTC ISO week-year (F6)', () => {
  it.each([
    ['2020-12-31', '2020-W53'],
    ['2021-01-01', '2020-W53'],
    ['2021-01-04', '2021-W01'],
    ['2026-12-31', '2026-W53'],
    ['2027-01-01', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2014-12-29', '2015-W01'],
    ['2015-01-01', '2015-W01'],
    ['2016-01-01', '2015-W53'],
    ['2018-01-01', '2018-W01'],
    ['2018-12-31', '2019-W01'],
  ])('%s belongs to %s', (day, key) => {
    expect(periodKeyFor('WEEK', new Date(`${day}T12:00:00Z`))).toBe(key);
  });
  it('uses UTC for every period regardless of the supplied offset', () => {
    const at = new Date('2027-01-01T01:00:00+03:30');
    expect(periodKeyFor('DAY', at)).toBe('2026-12-31');
    expect(periodKeyFor('MONTH', at)).toBe('2026-12');
    expect(periodKeyFor('WEEK', at)).toBe('2026-W53');
  });
});

describe('D-080 applicability', () => {
  const at = new Date('2026-01-02T00:00:00Z');
  const rule: RewardRuleView = {
    id: 'R',
    organizationId: 'ORG-A',
    triggerEvent: 'USAGE_RECORDED',
    rewardType: 'POINTS',
    condition: null,
    points: 1,
    creditPerPointMinor: null,
    periodCap: null,
    periodType: null,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    status: 'INACTIVE',
  };
  it('fails closed with no status evidence', () => {
    expect(applicableRules([rule], 'ORG-A', 'USAGE_RECORDED', at)).toEqual([]);
  });
  it('uses the latest effective transition rather than current status', () => {
    expect(
      applicableRules(
        [
          {
            ...rule,
            statusHistory: [
              { id: 2n, status: 'INACTIVE', effectiveAt: new Date('2026-01-03T00:00:00Z') },
              { id: 1n, status: 'ACTIVE', effectiveAt: rule.validFrom },
            ],
          },
        ],
        'ORG-A',
        'USAGE_RECORDED',
        at,
      ),
    ).toHaveLength(1);
  });
});
