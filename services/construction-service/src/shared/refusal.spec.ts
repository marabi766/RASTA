import { RastaError } from '@rasta/nest-common';
import { refusal, refusalDetails, ruleRefusal } from './refusal';

describe('refusalDetails', () => {
  it('carries one entry per closed reason, in order, with a fixed message', () => {
    expect(refusalDetails('publication', ['NATURE_REQUIRED', 'WINDOW_REQUIRED'])).toEqual([
      {
        path: 'publication',
        code: 'NATURE_REQUIRED',
        message: 'Tender cannot be published: NATURE_REQUIRED',
      },
      {
        path: 'publication',
        code: 'WINDOW_REQUIRED',
        message: 'Tender cannot be published: WINDOW_REQUIRED',
      },
    ]);
  });

  it('is absent, never an empty array, without a closed reason', () => {
    expect(refusalDetails('bid', [])).toBeUndefined();
  });

  it('never carries anything that is not a closed code (S-09)', () => {
    const notClosed = ['', 'org_01JBQ8Z4K7M2N5P8R1T3V6X9Y2', 'not closed', 'Bad', 'X'.repeat(65)];
    expect(refusalDetails('award', notClosed)).toBeUndefined();
    expect(refusalDetails('award', ['tnd_01ABC', 'NOT_EVALUATED'])).toEqual([
      { path: 'award', code: 'NOT_EVALUATED', message: 'Award refused: NOT_EVALUATED' },
    ]);
  });
});

describe('refusal', () => {
  it('keeps the message and code, and the reasons in the server-only context', () => {
    const error = refusal('FORBIDDEN', 'Award refused: AWARDER_IS_EVALUATOR. Why.', 'award', [
      'AWARDER_IS_EVALUATOR',
    ]);
    expect(error).toBeInstanceOf(RastaError);
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Award refused: AWARDER_IS_EVALUATOR. Why.',
      details: [
        {
          path: 'award',
          code: 'AWARDER_IS_EVALUATOR',
          message: 'Award refused: AWARDER_IS_EVALUATOR',
        },
      ],
      internalContext: { refusals: ['AWARDER_IS_EVALUATOR'] },
    });
  });

  it('a rule refusal is 422 BUSINESS_RULE_VIOLATION and keeps its log context', () => {
    const error = ruleRefusal('Bid refused: OWN_TENDER', 'bid', ['OWN_TENDER'], {
      subject: 'tnd_1',
    });
    expect(error).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      status: 422,
      details: [{ path: 'bid', code: 'OWN_TENDER' }],
      internalContext: { subject: 'tnd_1', refusals: ['OWN_TENDER'] },
    });
  });

  it('the details never name the context', () => {
    const error = ruleRefusal('m', 'cancellation', ['REASON_CODE_NOT_APPLICABLE'], {
      tenderId: 'tnd_secret',
    });
    expect(JSON.stringify(error.details)).not.toContain('tnd_secret');
  });
});
