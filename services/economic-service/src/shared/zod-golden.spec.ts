import { RastaError, zodPipe } from '@rasta/nest-common';
import type { z } from 'zod';
import { hashRequestBody } from './idempotency';
import {
  cancelTransactionSchema,
  createTransactionSchema,
  disputeTransactionSchema,
  listTransactionsQuerySchema,
  refundTransactionSchema,
  resolveDisputeSchema,
  settleTransactionSchema,
} from '../transaction/dto';
import {
  listPaymentsQuerySchema,
  operatorDecisionSchema,
  proposeResolutionSchema,
  refundPaymentSchema,
  topUpSchema,
} from '../payment/dto';
import { createParticipationRuleSchema, createRecognitionRuleSchema } from '../reward/dto';
import { listSettlementsQuerySchema } from '../settlement/dto';

/**
 * Golden fixtures for the zod 4 migration (GHSA-mrhx-c7xc-m3w5, PR B).
 *
 * The snapshot beside this file was recorded under **zod 3.25.76** and is the
 * oracle B is measured against: what a body parses to and the idempotency hash
 * of that parse (a changed default or transform would change the hash, and a
 * retry sent across the deploy would be refused as `IDEMPOTENCY_KEY_REUSED`
 * instead of replayed), and what a query parses to (defaults, explicit `false`,
 * the cursor passed through untouched). Refusals carry the pipe's
 * `{ path, code, message }` details.
 *
 * Never re-record it (`-u`) to make a migration pass: a difference is a
 * behaviour change, fixed in the code. Two things are deliberately not pinned:
 * an over-cap array of invalid elements (zod 3 reports every element after
 * `too_big` — the advisory itself, which B changes), and a non-digit top-up
 * amount (the top-up refinement's `BigInt` throws on it, a 500 today).
 */

type Outcome = { parsed: unknown; hash: string } | { refused: string; details: unknown };

function outcome(schema: z.ZodTypeAny, input: unknown): Outcome {
  try {
    const parsed = zodPipe(schema).transform(input, { type: 'body' });
    return { parsed, hash: hashRequestBody(parsed) };
  } catch (error) {
    if (error instanceof RastaError) return { refused: error.code, details: error.details };
    throw error;
  }
}

const cases = (schema: z.ZodTypeAny, inputs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, outcome(schema, input)]));

const REASON = 'the delivered parts were not the ones ordered';

describe('zod-3 golden: idempotent request bodies and their hashes', () => {
  it('POST /v1/transactions', () => {
    expect(
      cases(createTransactionSchema, {
        minimal: { transactionType: 'MAINTENANCE_SERVICE', grossAmountMinor: '1000' },
        explicitDefaults: {
          transactionType: 'MAINTENANCE_SERVICE',
          grossAmountMinor: '1000',
          currency: 'IRR',
          holdFunds: false,
        },
        full: {
          transactionType: 'MARKETPLACE_ORDER',
          businessLine: 'PARTS',
          counterpartyOrganizationId: 'ORG-DEH-0001',
          grossAmountMinor: '9223372036854775807',
          occurredAt: '2026-10-01T10:00:00Z',
          sourceType: '  PURCHASE ',
          sourceReference: ' ref-1 ',
          holdFunds: true,
          idempotencyKey: '  key-00000001  ',
        },
        amountAsNumber: { transactionType: 'LOGISTICS', grossAmountMinor: 1000 },
        amountNegative: { transactionType: 'LOGISTICS', grossAmountMinor: '-1' },
        amountPastBigint: { transactionType: 'LOGISTICS', grossAmountMinor: '9223372036854775808' },
        holdFundsAsText: {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '1',
          holdFunds: 'false',
        },
        dateWithoutTime: {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '1',
          occurredAt: '2026-10-01',
        },
        offsetInstant: {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '1',
          occurredAt: '2026-10-01T10:00:00+03:30',
        },
        reservedSource: {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '1',
          sourceType: 'STATEMENT',
        },
        badOrganization: {
          transactionType: 'LOGISTICS',
          grossAmountMinor: '1',
          counterpartyOrganizationId: 'organization-1',
        },
        unknownType: { transactionType: 'WALLET_TOP_UP', grossAmountMinor: '1' },
        unknownKey: { transactionType: 'LOGISTICS', grossAmountMinor: '1', note: 'hello there' },
        missingEverything: {},
        notAnObject: 'transaction',
      }),
    ).toMatchSnapshot();
  });

  it('dispute, resolve, cancel, refund and settle', () => {
    expect({
      dispute: cases(disputeTransactionSchema, {
        trimmed: { reason: `  ${REASON}  ` },
        tooShort: { reason: ' too short ' },
        missing: {},
      }),
      resolve: cases(resolveDisputeSchema, {
        withoutDispute: { resolution: REASON },
        withDispute: { resolution: REASON, disputeId: ' DSP-1 ' },
        emptyDispute: { resolution: REASON, disputeId: '   ' },
      }),
      cancel: cases(cancelTransactionSchema, {
        trimmed: { reason: '  dup ' },
        blank: { reason: '  ' },
      }),
      refund: cases(refundTransactionSchema, { ok: { reason: 'returned' } }),
      settle: cases(settleTransactionSchema, {
        ok: { transactionId: ' TXN-1 ' },
        tooLong: { transactionId: 'T'.repeat(65) },
      }),
    }).toMatchSnapshot();
  });

  it('wallet top-up and payment refunds and reconciliation', () => {
    expect({
      topUp: cases(topUpSchema.omit({ idempotencyKey: true }), {
        ok: { amountMinor: '500', instrument: ' fail:INSUFFICIENT_FUNDS ' },
        zero: { amountMinor: '0' },
      }),
      topUpWithKey: cases(topUpSchema, {
        ok: { amountMinor: '500', idempotencyKey: ' key-00000001 ' },
      }),
      paymentRefund: cases(refundPaymentSchema, { ok: { reason: ' customer asked ' } }),
      propose: cases(proposeResolutionSchema, {
        ok: { providerOutcome: 'REFUNDED', evidenceReference: 'TICKET-42/a', reason: 'statement' },
        badEvidence: {
          providerOutcome: 'REFUNDED',
          evidenceReference: 'has spaces in it',
          reason: 'abc',
        },
        badOutcome: { providerOutcome: 'MAYBE', evidenceReference: 'TICKET-42', reason: 'abc' },
      }),
      decision: cases(operatorDecisionSchema, {
        ok: { reason: ' checked ' },
        extra: { reason: 'abc', x: 1 },
      }),
    }).toMatchSnapshot();
  });

  it('participation and recognition rule versions', () => {
    const contribution = { triggerEvent: 'USAGE_RECORDED', weight: 2 };
    expect({
      participation: cases(createParticipationRuleSchema, {
        ok: {
          expectedCurrentVersion: 0,
          windowDays: 30,
          contributions: [
            contribution,
            { triggerEvent: 'MAINTENANCE_COMPLETED', weight: 5, maxPerWindow: 3 },
          ],
          label: ' نمونه — نیازمند تصویب ',
        },
        duplicateEvent: {
          expectedCurrentVersion: 0,
          windowDays: 30,
          contributions: [contribution, contribution],
        },
        empty: { expectedCurrentVersion: 0, windowDays: 30, contributions: [] },
        // No over-cap array of invalid elements here: zod 3 reports every element
        // after `too_big`, which is GHSA-mrhx-c7xc-m3w5 itself and what B changes.
        overCap: {
          expectedCurrentVersion: 0,
          windowDays: 30,
          contributions: [contribution, contribution, contribution],
        },
        fractionalWeight: {
          expectedCurrentVersion: 0,
          windowDays: 30,
          contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 1.5 }],
        },
      }),
      recognition: cases(createRecognitionRuleSchema, {
        ok: {
          expectedCurrentVersion: 2,
          basis: 'PARTICIPATION_SCORE',
          levels: [
            { name: ' برنز ', threshold: 0 },
            { name: 'نقره', threshold: 10 },
          ],
          badges: [{ code: 'FIRST_USE', name: 'نخستین کارکرد', threshold: 1 }],
        },
        notALadder: {
          expectedCurrentVersion: 0,
          basis: 'PARTICIPATION_SCORE',
          levels: [
            { name: 'a', threshold: 10 },
            { name: 'b', threshold: 10 },
          ],
          badges: [],
        },
        nothing: {
          expectedCurrentVersion: 0,
          basis: 'PARTICIPATION_SCORE',
          levels: [],
          badges: [],
        },
        badBadge: {
          expectedCurrentVersion: 0,
          basis: 'REWARD_POINTS_CUMULATIVE',
          levels: [],
          badges: [{ code: 'lower', name: 'x', threshold: 1 }],
        },
      }),
    }).toMatchSnapshot();
  });
});

describe('zod-3 golden: list queries as they arrive in a query string', () => {
  it('GET /v1/transactions: defaults, explicit false, booleans, limits, cursors', () => {
    expect(
      cases(listTransactionsQuerySchema, {
        empty: {},
        explicitFalse: { includeIncoming: 'false' },
        explicitTrue: { includeIncoming: 'true' },
        zero: { includeIncoming: '0' },
        blank: { includeIncoming: '' },
        upperYes: { includeIncoming: ' YES ' },
        notABoolean: { includeIncoming: 'maybe' },
        limit: { limit: '5' },
        limitZero: { limit: '0' },
        limitTooBig: { limit: '101' },
        limitFraction: { limit: '5.5' },
        limitText: { limit: 'abc' },
        cursor: { cursor: 'TXN_01J9ZS3X5Y0000000000000000' },
        emptyCursor: { cursor: '' },
        range: { from: '2026-01-01T00:00:00Z', to: '2026-01-31T23:59:59.999Z' },
        badStatus: { status: 'BOGUS' },
        trimmedSource: { sourceType: ' ORDER ', sourceReference: ' o-1 ' },
        unknownParameter: { userId: 'USR-1' },
      }),
    ).toMatchSnapshot();
  });

  it('GET /v1/payment-intents and GET /v1/settlements', () => {
    expect({
      payments: cases(listPaymentsQuerySchema, {
        empty: {},
        limit: { limit: '100' },
        extra: { all: '1' },
      }),
      settlements: cases(listSettlementsQuerySchema, { empty: {}, limit: { limit: '7' } }),
    }).toMatchSnapshot();
  });
});
