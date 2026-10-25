import {
  CLOSED_RFQ_STATES,
  FINAL_RFQ_STATES,
  INITIAL_RFQ_STATE,
  RFQ_STATES,
  RFQ_TRANSITIONS,
  canTransitionRfq,
  deadlinePassed,
  rfqTransition,
  type RfqStateName,
} from './rfq.state-machine';

/** Every (from, to) pair of the RFQ lifecycle (ADR-070 § 3): what is declared is all there is. */
const ALLOWED: ReadonlySet<string> = new Set([
  'PUBLISHED>CLOSED',
  'CLOSED>EVALUATING',
  'EVALUATING>EVALUATED',
  'EVALUATED>AWARDED',
  'PUBLISHED>CANCELLED',
  'CLOSED>CANCELLED',
  'EVALUATING>CANCELLED',
  'EVALUATED>CANCELLED',
]);

describe('the RFQ lifecycle', () => {
  it.each(RFQ_STATES.flatMap((from) => RFQ_STATES.map((to) => [from, to] as const)))(
    '%s → %s is a transition exactly when declared',
    (from: RfqStateName, to: RfqStateName) => {
      expect(canTransitionRfq(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
    },
  );

  it('is born PUBLISHED; AWARDED and CANCELLED lead nowhere; every status but AWARDED cancels', () => {
    expect(INITIAL_RFQ_STATE).toBe('PUBLISHED');
    for (const final of FINAL_RFQ_STATES) {
      expect(RFQ_TRANSITIONS.filter((entry) => entry.from === final)).toEqual([]);
    }
    expect(
      RFQ_STATES.filter((state) => rfqTransition(state, 'cancel') === 'CANCELLED').sort(),
    ).toEqual(['CLOSED', 'EVALUATED', 'EVALUATING', 'PUBLISHED']);
    expect(rfqTransition('PUBLISHED', 'close')).toBe('CLOSED');
    expect(rfqTransition('CLOSED', 'close')).toBeNull();
  });

  it('the closed statuses are those reached through the close, the cancelled one excepted', () => {
    expect([...CLOSED_RFQ_STATES].sort()).toEqual(['AWARDED', 'CLOSED', 'EVALUATED', 'EVALUATING']);
  });

  it('the deadline is half-open: one millisecond before it is open, at it closed', () => {
    const deadline = new Date('2031-01-01T00:00:00.000Z');
    expect(deadlinePassed(deadline, new Date(deadline.getTime() - 1))).toBe(false);
    expect(deadlinePassed(deadline, deadline)).toBe(true);
    expect(deadlinePassed(deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });
});
