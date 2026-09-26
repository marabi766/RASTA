import { concludedOutcomeProblems, type ConcludedOutcomeInput } from './concluded-outcome';
import { OUTCOME_FIELDS } from './concluded-outcome.repository';

const OUTCOME: ConcludedOutcomeInput = {
  organizationId: 'ORG_SUPPLIER',
  sourceEventId: 'EVT_1',
  sourceEventName: 'ORDER_COMPLETED',
  outcomeKind: 'ORDER',
  outcomeKey: 'ORD_1',
  occurredAt: new Date('2026-09-26T10:00:00.000Z'),
  correlationId: 'COR_1',
};

describe('a concluded outcome (ADR-052 step 5)', () => {
  it('accepts a completed order', () => {
    expect(concludedOutcomeProblems(OUTCOME)).toEqual([]);
  });

  it.each(['organizationId', 'sourceEventId', 'sourceEventName', 'outcomeKey', 'correlationId'])(
    'refuses a blank %s',
    (field) => {
      expect(
        concludedOutcomeProblems({ ...OUTCOME, [field]: ' ' }).map((problem) => problem.path),
      ).toEqual([field]);
    },
  );

  it('refuses an unknown outcome kind and an invalid time', () => {
    expect(
      concludedOutcomeProblems({
        ...OUTCOME,
        outcomeKind: 'PROJECT' as never,
        occurredAt: new Date('not a time'),
      }).map((problem) => problem.path),
    ).toEqual(['outcomeKind', 'occurredAt']);
  });

  it('compares every field that states the outcome on redelivery, and no delivery metadata', () => {
    expect([...OUTCOME_FIELDS, 'correlationId', 'sourceEventId'].sort()).toEqual(
      Object.keys(OUTCOME).sort(),
    );
  });
});
