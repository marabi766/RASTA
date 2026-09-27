import { RESPONSIBILITY_ATTRIBUTIONS } from './components';
import {
  assertValidPerformanceEvent,
  attributionEffect,
  countsTowardDenominator,
  performanceEventProblems,
  type PerformanceEventInput,
} from './performance-event';

/**
 * Domain rules of a performance fact (ADR-052 § 4, § 6, § 11, § 14).
 *
 * The same rules the `performance_event` CHECKs enforce; the integration suite
 * proves the database refuses what these refuse.
 */

const RATING: PerformanceEventInput = {
  organizationId: 'ORG_SUPPLIER',
  sourceEventId: 'EVT_1',
  sourceEventName: 'REVIEW_SUBMITTED',
  component: 'CUSTOMER_SATISFACTION',
  outcomeKind: 'ORDER',
  outcomeKey: 'ORD_1',
  responsibility: null,
  rating: 4,
  promisedAt: null,
  deliveredAt: null,
  compensatesSourceEventId: null,
  occurredAt: new Date('2026-09-26T10:00:00.000Z'),
  correlationId: 'COR_1',
};

const DISPUTE: PerformanceEventInput = {
  ...RATING,
  sourceEventName: 'ORDER_DISPUTE_RESOLVED',
  component: 'DISPUTE_ABSENCE',
  rating: null,
  responsibility: 'SUPPLIER',
};

const PROMISE: PerformanceEventInput = {
  ...RATING,
  sourceEventName: 'ORDER_CREATED',
  component: 'ON_TIME',
  rating: null,
  promisedAt: new Date('2026-10-01T00:00:00.000Z'),
};

function paths(input: PerformanceEventInput): string[] {
  return performanceEventProblems(input).map((problem) => problem.path);
}

describe('a valid fact', () => {
  it.each([
    ['a rating', RATING],
    ['an attributed dispute outcome', DISPUTE],
    ['a delivery promise', PROMISE],
    ['a delivery', { ...PROMISE, promisedAt: null, deliveredAt: new Date() }],
    [
      'an undetermined cancellation',
      { ...DISPUTE, component: 'CANCELLATION_ABSENCE', responsibility: 'UNDETERMINED' },
    ],
    [
      'a correction naming the fact it corrects',
      { ...DISPUTE, sourceEventId: 'EVT_2', compensatesSourceEventId: 'EVT_1' },
    ],
  ] as const)('accepts %s', (_label, input) => {
    expect(performanceEventProblems(input as PerformanceEventInput)).toEqual([]);
  });
});

describe('responsibility (rule 13)', () => {
  it('is required where the component is about fault', () => {
    expect(paths({ ...DISPUTE, responsibility: null })).toEqual(['responsibility']);
  });

  it('is refused where it is not', () => {
    expect(paths({ ...RATING, responsibility: 'SUPPLIER' })).toEqual(['responsibility']);
  });

  it('is a closed set — an unlisted value is refused, never coerced', () => {
    expect(paths({ ...DISPUTE, responsibility: 'VENDOR' as never })).toEqual(['responsibility']);
  });

  it('holds exactly the four values marketplace publishes', () => {
    expect([...RESPONSIBILITY_ATTRIBUTIONS]).toEqual([
      'SUPPLIER',
      'BUYER',
      'PLATFORM',
      'UNDETERMINED',
    ]);
  });
});

describe('UNDETERMINED is excluded from the denominator, not counted as zero (ADR-052 § 4, § 5)', () => {
  it('excludes UNDETERMINED', () => {
    expect(attributionEffect('UNDETERMINED')).toBe('EXCLUDED');
    expect(countsTowardDenominator('UNDETERMINED')).toBe(false);
  });

  it('counts SUPPLIER against the supplier', () => {
    expect(attributionEffect('SUPPLIER')).toBe('AGAINST_SUPPLIER');
    expect(countsTowardDenominator('SUPPLIER')).toBe(true);
  });

  it.each(['BUYER', 'PLATFORM'] as const)('never counts %s as the supplier’s fault', (who) => {
    expect(attributionEffect(who)).toBe('NOT_AGAINST_SUPPLIER');
    expect(countsTowardDenominator(who)).toBe(true);
  });
});

describe('the measurement fits its component', () => {
  it.each([0, 6, 3.5])('refuses a rating of %s', (rating) => {
    expect(paths({ ...RATING, rating })).toEqual(['rating']);
  });

  it('refuses a satisfaction fact with no rating', () => {
    expect(paths({ ...RATING, rating: null })).toEqual(['rating']);
  });

  it('refuses a rating on any other component', () => {
    expect(paths({ ...DISPUTE, rating: 3 })).toEqual(['rating']);
  });

  it('refuses an ON_TIME fact carrying both sides, or neither', () => {
    expect(paths({ ...PROMISE, deliveredAt: new Date() })).toEqual(['promisedAt']);
    expect(paths({ ...PROMISE, promisedAt: null })).toEqual(['promisedAt']);
  });

  it('refuses a timestamp on a component that has none', () => {
    expect(paths({ ...RATING, deliveredAt: new Date() })).toEqual(['promisedAt']);
  });

  it('refuses QUALITY until docs/24 Q-56 names its producer', () => {
    expect(paths({ ...RATING, component: 'QUALITY', rating: null })).toEqual(['component']);
  });
});

describe('identity and correction', () => {
  it.each([
    'organizationId',
    'sourceEventId',
    'sourceEventName',
    'outcomeKey',
    'correlationId',
  ] as const)('refuses a blank %s', (field) => {
    expect(paths({ ...RATING, [field]: '\t ' })).toEqual([field]);
  });

  it('refuses an outcome kind outside ORDER / REPAIR_ORDER', () => {
    expect(paths({ ...RATING, outcomeKind: 'PROJECT' as never })).toEqual(['outcomeKind']);
  });

  it('refuses a fact that compensates itself', () => {
    expect(paths({ ...DISPUTE, compensatesSourceEventId: DISPUTE.sourceEventId })).toEqual([
      'compensatesSourceEventId',
    ]);
  });

  it('throws VALIDATION_FAILED with every problem', () => {
    expect(() => assertValidPerformanceEvent({ ...RATING, rating: null, outcomeKey: '' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
