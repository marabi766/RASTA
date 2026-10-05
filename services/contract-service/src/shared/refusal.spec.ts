import { ERROR_CODES } from '@rasta/contracts';
import {
  REFUSAL_AREAS,
  REFUSAL_REASONS,
  forbiddenRefusal,
  refusal,
  refusalDetails,
  ruleRefusal,
} from './refusal';

describe('refusalDetails: the closed reason in details[].code (docs/06 § 6.7)', () => {
  it('is one entry per reason, with the area as the path and a fixed message', () => {
    expect(refusalDetails('signature', ['CONTRACT_NOT_DRAFT'])).toEqual([
      {
        path: 'signature',
        code: 'CONTRACT_NOT_DRAFT',
        message: 'Contract cannot be signed: CONTRACT_NOT_DRAFT',
      },
    ]);
    expect(refusalDetails('cancellation', ['SIGNATURE_RECORDED', 'CONTRACT_NOT_DRAFT'])).toEqual([
      {
        path: 'cancellation',
        code: 'SIGNATURE_RECORDED',
        message: 'Contract cannot be cancelled: SIGNATURE_RECORDED',
      },
      {
        path: 'cancellation',
        code: 'CONTRACT_NOT_DRAFT',
        message: 'Contract cannot be cancelled: CONTRACT_NOT_DRAFT',
      },
    ]);
  });

  it('never carries anything that is not a closed code: an id, a sentence, an empty string', () => {
    expect(refusalDetails('signature', ['CTR_01', 'a sentence', '', 'with space'])).toBeUndefined();
    expect(refusalDetails('signature', ['CONTRACT_NOT_DRAFT', 'CTR_01'])).toHaveLength(1);
  });

  it('is absent, not empty, when there is no closed reason', () => {
    expect(refusalDetails('signature', [])).toBeUndefined();
  });
});

describe('the refusals', () => {
  it('carry the details, and keep the reasons in the server-side context for the log', () => {
    const error = ruleRefusal(
      'Only a draft contract is signed',
      'signature',
      ['CONTRACT_NOT_DRAFT'],
      {
        contractId: 'CTR_1',
      },
    );
    expect(error.code).toBe(ERROR_CODES.BUSINESS_RULE_VIOLATION);
    expect(error.message).toBe('Only a draft contract is signed');
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'signature', code: 'CONTRACT_NOT_DRAFT' }),
    ]);
    expect(error.internalContext).toEqual({
      contractId: 'CTR_1',
      refusals: ['CONTRACT_NOT_DRAFT'],
    });
    // Nothing of the server-side context reaches what the client reads.
    expect(JSON.stringify(error.details)).not.toContain('CTR_1');
  });

  it('is 403 for a person who may not act and 422 for a rule', () => {
    expect(forbiddenRefusal('x', 'signature', ['SAME_PERSON_BOTH_SIDES']).code).toBe(
      ERROR_CODES.FORBIDDEN,
    );
    expect(
      refusal(ERROR_CODES.ALREADY_EXISTS, 'x', 'signature', ['SIDE_ALREADY_SIGNED']).code,
    ).toBe(ERROR_CODES.ALREADY_EXISTS);
  });
});

describe('the closed reasons', () => {
  it('are upper-case codes, each answered with 403, 409 or 422, in an area that names its own refusals', () => {
    expect(Object.keys(REFUSAL_REASONS).sort()).toEqual(Object.keys(REFUSAL_AREAS).sort());
    for (const reasons of Object.values(REFUSAL_REASONS)) {
      for (const [code, status] of Object.entries(reasons)) {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect([403, 409, 422]).toContain(status);
      }
    }
  });

  it('answer a person who may not act 403, a state that moved 409 and a rule 422', () => {
    expect(REFUSAL_REASONS.signature).toMatchObject({
      MEMBER_OF_BOTH_PARTIES: 403,
      SAME_PERSON_BOTH_SIDES: 403,
      SIDE_ALREADY_SIGNED: 409,
      CONTRACT_NOT_DRAFT: 422,
      ACTOR_IDENTITY_UNKNOWN: 422,
      SIGNER_AUTHORITY_NOT_CONFIGURED: 422,
    });
    expect(REFUSAL_REASONS.cancellation).toEqual({
      CANCEL_REASON_NOT_ALLOWED: 422,
      CONTRACT_NOT_DRAFT: 422,
      SIGNATURE_RECORDED: 422,
    });
  });
});
