import { ERROR_CODES } from '@rasta/contracts';
import { REFUSAL_AREAS, REFUSAL_REASONS, refusal, refusalDetails, ruleRefusal } from './refusal';

describe('refusalDetails: the closed reason in details[].code (docs/06 § 6.7)', () => {
  it('is one entry per reason, with the area as the path and a fixed message', () => {
    expect(refusalDetails('withdrawal', ['AGGREGATION_WINDOW_ENDED'])).toEqual([
      {
        path: 'withdrawal',
        code: 'AGGREGATION_WINDOW_ENDED',
        message: 'Demand cannot be withdrawn: AGGREGATION_WINDOW_ENDED',
      },
    ]);
  });

  it('never carries anything that is not a closed code: an id, a sentence, an empty string', () => {
    expect(
      refusalDetails('withdrawal', ['DMD_01', 'a sentence', '', 'with space']),
    ).toBeUndefined();
    expect(refusalDetails('withdrawal', ['DEMAND_NOT_SUBMITTED', 'DMD_01'])).toHaveLength(1);
  });

  it('names the submission’s area for the quantity limit', () => {
    expect(refusalDetails('submission', ['AGGREGATION_QUANTITY_LIMIT_EXCEEDED'])).toEqual([
      {
        path: 'submission',
        code: 'AGGREGATION_QUANTITY_LIMIT_EXCEEDED',
        message: 'Demand cannot be submitted: AGGREGATION_QUANTITY_LIMIT_EXCEEDED',
      },
    ]);
    expect(refusalDetails('submission', ['AGGREGATION_WINDOW_ENDED'])).toBeUndefined();
  });

  it('is absent, not empty, when there is no closed reason', () => {
    expect(refusalDetails('withdrawal', [])).toBeUndefined();
  });
});

describe('the refusals', () => {
  it('carry the details, and keep the reasons in the server-side context for the log', () => {
    const error = ruleRefusal('The window has ended', 'withdrawal', ['AGGREGATION_WINDOW_ENDED'], {
      demandId: 'DMD_1',
    });
    expect(error.code).toBe(ERROR_CODES.BUSINESS_RULE_VIOLATION);
    expect(error.message).toBe('The window has ended');
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'withdrawal', code: 'AGGREGATION_WINDOW_ENDED' }),
    ]);
    expect(error.internalContext).toEqual({
      demandId: 'DMD_1',
      refusals: ['AGGREGATION_WINDOW_ENDED'],
    });
  });

  it('answer with the code given', () => {
    expect(refusal('CONFLICT', 'moved', 'withdrawal', []).code).toBe('CONFLICT');
  });

  it('name an area for every reason table, and a status for every reason', () => {
    expect(Object.keys(REFUSAL_REASONS)).toEqual(Object.keys(REFUSAL_AREAS));
    for (const reasons of Object.values(REFUSAL_REASONS)) {
      for (const status of Object.values(reasons)) expect([403, 409, 422]).toContain(status);
    }
  });
});
