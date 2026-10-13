import { REFUSAL_REASONS, refusal, refusalDetails } from './refusal';

describe('closed refusals (docs/06 § 6.7)', () => {
  it('answers a rule with 422 and a state that moved with 409, each naming its closed reason', () => {
    const rule = refusal('reservation', 'INSUFFICIENT_AVAILABLE_STOCK', 'Not enough', {
      stockItemId: 'SKI_1',
    });
    expect([rule.code, rule.status]).toEqual(['BUSINESS_RULE_VIOLATION', 422]);
    expect(rule.details).toEqual([
      {
        path: 'reservation',
        code: 'INSUFFICIENT_AVAILABLE_STOCK',
        message: 'Reservation cannot be made or ended: INSUFFICIENT_AVAILABLE_STOCK',
      },
    ]);
    expect(rule.internalContext).toEqual({
      stockItemId: 'SKI_1',
      refusal: 'INSUFFICIENT_AVAILABLE_STOCK',
    });

    const state = refusal('reservation', 'RESERVATION_NOT_ACTIVE', 'Ended');
    expect([state.code, state.status]).toEqual(['INVALID_STATE_TRANSITION', 409]);
  });

  it('lets no reason outside the area’s closed list reach `details`', () => {
    expect(refusalDetails('stock', ['NOT_A_REASON'])).toBeUndefined();
    expect(refusalDetails('stock', ['INSUFFICIENT_AVAILABLE_STOCK'])).toBeUndefined();
    expect(refusalDetails('stock', ['QUANTITY_OUT_OF_RANGE', 'nope'])).toEqual([
      expect.objectContaining({ code: 'QUANTITY_OUT_OF_RANGE' }),
    ]);
  });

  it('answers every reason with 409 or 422 only', () => {
    for (const reasons of Object.values(REFUSAL_REASONS)) {
      for (const status of Object.values(reasons)) expect([409, 422]).toContain(status);
    }
  });
});
