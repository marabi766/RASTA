import { RastaError } from '@rasta/nest-common';
import { NON_NEGATIVE_AMOUNT_CONSTRAINTS, negativeAmountRefusal } from './negative-amount';

/**
 * The two shapes Prisma 6 gives a CHECK violation, as measured against
 * PostgreSQL 16 (audit L7-36): `create`/`updateMany` throw an unknown request
 * error whose message prints the driver error in its debug form (escaped
 * quotes); `$executeRaw` throws `P2010` with the PostgreSQL message in `meta`.
 * Both carry the failing row — the amount with it.
 */
const SECRET_ROW = 'Failing row contains (CLM_1, INS_1, AST_1, ORG-A, null, -987654321, APPROVED)';

const fromCreate = (constraint: string) =>
  Object.assign(new Error(), {
    name: 'PrismaClientUnknownRequestError',
    message:
      'Invalid `tx.insuranceClaim.updateMany()` invocation\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { ' +
      `code: "23514", message: "new row for relation \\"insurance_claim\\" violates check constraint \\"${constraint}\\"", ` +
      `severity: "ERROR", detail: Some("${SECRET_ROW}."), column: None, hint: None }), transient: false })`,
  });

const fromRaw = (constraint: string) =>
  Object.assign(new Error('Raw query failed. Code: `23514`.'), {
    code: 'P2010',
    meta: {
      code: '23514',
      message: `ERROR: new row for relation "insurance_policy" violates check constraint "${constraint}"\nDETAIL: ${SECRET_ROW}.`,
    },
  });

describe('negativeAmountRefusal', () => {
  const CASES = Object.entries(NON_NEGATIVE_AMOUNT_CONSTRAINTS);

  it.each(CASES)('maps %s to the API’s 400 on %s', (constraint, path) => {
    for (const error of [fromCreate(constraint), fromRaw(constraint)]) {
      const refusal = negativeAmountRefusal(error);
      expect(refusal).toBeInstanceOf(RastaError);
      expect(refusal).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 400,
        details: [
          {
            path,
            code: 'invalid_string',
            message: 'Amount must be a non-negative integer string in minor units',
          },
        ],
      });
    }
  });

  it('carries nothing of the driver text: no row, no amount (S-09)', () => {
    const refusal = negativeAmountRefusal(fromCreate('ck_claim_approved_amount_non_negative'));
    const everything = JSON.stringify({ ...refusal, message: refusal?.message });
    expect(everything).not.toContain('987654321');
    expect(everything).not.toContain('Failing row');
    expect(everything).not.toContain('ck_claim_approved_amount_non_negative');
  });

  it('leaves every other CHECK to the caller, including the claim’s own', () => {
    for (const constraint of [
      'ck_claim_rejected_has_no_approved_amount',
      'ck_claim_decided_iff_decision_recorded',
      // A name that merely contains one of ours is not ours.
      'ck_policy_premium_non_negative_v2',
    ]) {
      expect(negativeAmountRefusal(fromCreate(constraint))).toBeUndefined();
      expect(negativeAmountRefusal(fromRaw(constraint))).toBeUndefined();
    }
  });

  it('leaves anything that is not a CHECK violation to the caller', () => {
    for (const error of [
      { code: 'P2002', meta: { target: ['policy_number'] } },
      new Error('connection terminated'),
      new Error('ck_policy_premium_non_negative'),
      null,
      undefined,
      'violates check constraint "ck_policy_premium_non_negative"',
    ]) {
      expect(negativeAmountRefusal(error)).toBeUndefined();
    }
  });
});
