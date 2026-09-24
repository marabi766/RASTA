import {
  ORDER_SPINE,
  isOrderCommand,
  stepperFor,
  type StepState,
  type StepperOrder,
} from './order-fields';

/**
 * The stepper — the one piece of order logic the portal does own.
 *
 * It answers "where is this order", never "what may you do": the second comes
 * from the service's `availableActions`. What matters here is that the answer
 * is honest when the order has left its normal path: a disputed order is not
 * on its way to settlement, and drawing the remaining steps as "next" would
 * say something the service has not.
 */

const BLANK: StepperOrder = {
  status: 'PENDING',
  confirmedAt: null,
  fulfilledAt: null,
  receiptConfirmedAt: null,
  completedAt: null,
};

const states = (order: StepperOrder): StepState[] => stepperFor(order).map((s) => s.state);
const AT = '2026-09-20T08:00:00.000Z';

describe('an order on its normal path', () => {
  it('marks earlier steps done, its own current, later upcoming', () => {
    expect(states({ ...BLANK, status: 'CONFIRMED' })).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });

  it('shows funds held as its own step, before the supplier confirms', () => {
    // The step a buyer most needs to see: their money is committed before
    // the supplier has said yes.
    const steps = stepperFor({ ...BLANK, status: 'FUNDS_HELD' });
    expect(steps.map((s) => s.status).indexOf('FUNDS_HELD')).toBeLessThan(
      steps.map((s) => s.status).indexOf('CONFIRMED'),
    );
    expect(steps.find((s) => s.status === 'FUNDS_HELD')?.state).toBe('current');
  });

  it('has every step done at completion except the last, which is current', () => {
    const result = states({ ...BLANK, status: 'COMPLETED' });
    expect(result.slice(0, -1).every((s) => s === 'done')).toBe(true);
    expect(result.at(-1)).toBe('current');
  });

  it('covers the whole spine, in order', () => {
    expect(stepperFor(BLANK).map((s) => s.status)).toEqual([...ORDER_SPINE]);
  });
});

describe('an order off its normal path', () => {
  it('never draws a disputed order as heading towards settlement', () => {
    const result = states({ ...BLANK, status: 'DISPUTED', confirmedAt: AT, fulfilledAt: AT });
    expect(result).not.toContain('upcoming');
    expect(result).not.toContain('current');
  });

  it('marks done only what the order carries proof of', () => {
    const steps = stepperFor({
      ...BLANK,
      status: 'DISPUTED',
      confirmedAt: AT,
      fulfilledAt: AT,
    });
    const byStatus = Object.fromEntries(steps.map((s) => [s.status, s.state]));

    expect(byStatus.PENDING).toBe('done');
    // No timestamp of its own, but nothing reaches CONFIRMED without it.
    expect(byStatus.FUNDS_HELD).toBe('done');
    expect(byStatus.CONFIRMED).toBe('done');
    expect(byStatus.AWAITING_RECEIPT_CONFIRMATION).toBe('done');
    expect(byStatus.RECEIPT_CONFIRMED).toBe('not-reached');
    expect(byStatus.SETTLING).toBe('not-reached');
    expect(byStatus.COMPLETED).toBe('not-reached');
  });

  it('does not claim funds were held for an order cancelled before confirmation', () => {
    const steps = stepperFor({ ...BLANK, status: 'CANCELLED' });
    expect(steps.find((s) => s.status === 'FUNDS_HELD')?.state).toBe('not-reached');
    expect(steps.find((s) => s.status === 'PENDING')?.state).toBe('done');
  });

  it.each(['CANCELLING', 'CANCELLED', 'FAILED', 'DISPUTED'])(
    'treats %s as off the path',
    (status) => {
      expect(states({ ...BLANK, status })).not.toContain('current');
    },
  );
});

describe('isOrderCommand', () => {
  it('knows the seven commands and nothing else', () => {
    expect(isOrderCommand('CONFIRM_RECEIPT')).toBe(true);
    expect(isOrderCommand('SETTLE')).toBe(false);
    expect(isOrderCommand(undefined)).toBe(false);
  });
});
