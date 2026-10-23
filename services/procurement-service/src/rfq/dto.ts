import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PROCUREMENT_NATURES,
  RFQ_CANCELLATION_CODE_PATTERN,
  cursorPaginationSchema,
  organizationIdSchema,
  plainText,
} from '@rasta/contracts';
import { canonicalize } from '@rasta/sealing';
import { MAX_INVITEES_LIMIT } from '../config/env';
import { MAX_QUANTITY, MAX_REASON_LENGTH } from '../demand/dto';
import { codePointLength } from '../openapi/zod-schema';
import { RFQ_STATES } from './rfq.state-machine';

/**
 * The request and response shapes of the RFQ API (ADR-070 § 3; the planned contract
 * `docs/api/procurement-service.planned.openapi.json`, operations of plan PR 6).
 *
 * The same Zod schemas validate input, type the code and become the OpenAPI document. Every command
 * takes a strict body: nothing in it decides who acts, for which organization, or when.
 */

/** The scoring methods the code implements (ADR-067 § 1, Q-88). A new one is code and an ADR. */
export const SCORING_METHODS = ['MANUAL_SCORE', 'PASS_FAIL'] as const;

/** A criteria list weighs exactly this many basis points (ADR-067 § 1). */
export const TOTAL_WEIGHT_BP = 10_000;

/** The most criteria one RFQ holds: construction's bound (`MAX_CRITERIA`), a CHECK too. */
export const MAX_CRITERIA = 50;

const PROVISIONAL = 'Provisional (docs/24 Q-88, ADR-067 § 1):';

export const criterionSchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/, 'A code is 1 to 50 letters, digits, _ . or -')
      .describe('Identifies the criterion within the RFQ; what scores will refer to.'),
    label: codePointLength(plainText(), 1, 200).describe(
      'Trimmed, 1 to 200 characters, without bidirectional control characters.',
    ),
    weightBp: z
      .number()
      .int()
      .min(1)
      .max(TOTAL_WEIGHT_BP)
      .describe(`${PROVISIONAL} the weight in basis points; an RFQ's weights sum to 10000.`),
    scoringMethod: z
      .enum(SCORING_METHODS)
      .describe(`${PROVISIONAL} MANUAL_SCORE (0..maxScore) or PASS_FAIL (0 or 1).`),
    maxScore: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .describe(`${PROVISIONAL} the whole-number maximum; 1 for PASS_FAIL.`),
  })
  .strict()
  .refine((value) => value.scoringMethod !== 'PASS_FAIL' || value.maxScore === 1, {
    message: 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1',
    path: ['maxScore'],
  });

export type Criterion = z.infer<typeof criterionSchema>;

/** `POST /v1/aggregations/{id}/rfq`: everything an RFQ is, with no default (ADR-070 § 3). */
export const issueRfqSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe(
        'The `version` of the aggregation the caller read: the issue applies only to that version ' +
          '(409 OPTIMISTIC_LOCK_FAILED otherwise).',
      ),
    procurementNature: z
      .enum(PROCUREMENT_NATURES)
      .describe('Required, with no default (ADR-023, Q-03).'),
    quotationClosingAt: z
      .string()
      .datetime({ offset: false })
      .describe(
        'The quotation deadline (UTC, ISO 8601 with Z; kept to the millisecond). Must be after ' +
          'the database clock at the issue; no minimum or maximum is invented (Q-121 (2)). ' +
          'Quotations are taken before it; the RFQ is closed at or after it.',
      ),
    criteria: z
      .array(criterionSchema)
      .min(1)
      .max(MAX_CRITERIA)
      .refine((items) => new Set(items.map((item) => item.code)).size === items.length, {
        message: 'Criterion codes must be unique',
      })
      .refine((items) => items.reduce((sum, item) => sum + item.weightBp, 0) === TOTAL_WEIGHT_BP, {
        message: `The weights must sum to exactly ${TOTAL_WEIGHT_BP} basis points`,
      })
      .describe(
        'Copied into the RFQ and frozen with it (ADR-067 § 1): 1 to 50, unique codes, weights ' +
          'summing to exactly 10000.',
      ),
    invitedSupplierOrganizationIds: z
      .array(organizationIdSchema)
      .min(1)
      .max(MAX_INVITEES_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'An organization is invited once',
      })
      .describe(
        'The organizations invited to quote (Q-121 (1): invitation only). Each must hold an ' +
          'approved GOODS_SUPPLY qualification and no open suspension now, by supplier-service ' +
          '(422 INVITEE_NOT_ELIGIBLE; unreachable, 503). Never the buyer. At most ' +
          'PROCUREMENT_RFQ_MAX_INVITEES (default 200; 422 INVITEE_LIMIT_EXCEEDED above it), and ' +
          'never more than 500.',
      ),
  })
  .strict();
export type IssueRfqDto = z.infer<typeof issueRfqSchema>;

/**
 * `POST /v1/rfqs/{id}/cancel`: any status but AWARDED → CANCELLED, for a reason code from the
 * configured closed list, with an optional text (the planned `CancelRfq`).
 */
export const cancelRfqSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe('The `version` of the RFQ the caller read (409 OPTIMISTIC_LOCK_FAILED otherwise).'),
    reasonCode: z
      .string()
      .regex(RFQ_CANCELLATION_CODE_PATTERN, 'A reason code is upper-case words, 2 to 64 characters')
      .describe(
        'One of the codes PROCUREMENT_RFQ_CANCELLATION_CODES names (a closed list from ' +
          'configuration, BUYER_REQUEST by default; another is 422 ' +
          'CANCELLATION_CODE_NOT_ALLOWED). The event carries it.',
      ),
    reason: codePointLength(plainText(), 0, MAX_REASON_LENGTH)
      .optional()
      .describe(
        'Optional: why, up to 500 characters, trimmed, without bidirectional control ' +
          'characters (empty is none). Kept with the RFQ and read by the buyer through this ' +
          'API; never on an event.',
      ),
  })
  .strict();
export type CancelRfqDto = z.infer<typeof cancelRfqSchema>;

/** Which side of an RFQ the caller lists: its own organization's, or the ones it is invited to. */
export const RFQ_SIDES = ['BUYER', 'SUPPLIER'] as const;

export const listRfqsQuerySchema = cursorPaginationSchema
  .extend({
    side: z
      .enum(RFQ_SIDES)
      .describe(
        'BUYER: the RFQs of the caller organization. SUPPLIER: the RFQs the caller organization is ' +
          'invited to, and nothing else.',
      ),
    status: z.enum(RFQ_STATES).optional(),
  })
  .strict();
export type ListRfqsQuery = z.infer<typeof listRfqsQuerySchema>;

const utcInstant = (what: string) => z.string().describe(`${what} (UTC, ISO 8601 with Z).`);

/**
 * An RFQ as its buyer reads it, or as an invited supplier does — the product, the total quantity,
 * the criteria and the deadline, never who registered the demands (ADR-070 § 10). The fields marked
 * "buyer side only" are absent from a supplier's view.
 */
export const rfqViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The buyer.'),
    aggregationId: z.string(),
    productId: z.string(),
    totalQuantity: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUANTITY)
      .describe("The aggregation's total, frozen at issue: the quantity every quotation prices."),
    status: z.enum(RFQ_STATES),
    procurementNature: z.enum(PROCUREMENT_NATURES),
    quotationClosingAt: utcInstant('The quotation deadline, exclusive'),
    criteria: z.array(criterionSchema).describe('Frozen at issue, in the order it listed them.'),
    criteriaDigest: z
      .string()
      .describe('SHA-256 (hex) of the criteria’s canonical form: what RFQ_ISSUED names them by.'),
    invitedSupplierOrganizationIds: z
      .array(z.string())
      .optional()
      .describe('Buyer side only: the organizations invited, by organization id.'),
    issuedAt: utcInstant('When it was issued, by the database clock'),
    closedAt: z.string().nullable().describe('When it was closed (UTC, ISO 8601 with Z), or null.'),
    cancelledAt: z
      .string()
      .nullable()
      .describe('When it was cancelled (UTC, ISO 8601 with Z), or null.'),
    cancelReasonCode: z
      .string()
      .nullable()
      .describe('The reason code it was cancelled for, or null.'),
    cancelReason: z
      .string()
      .nullable()
      .optional()
      .describe('Buyer side only: why it was cancelled, or null.'),
    version: z.number().int(),
  })
  .strict();
export type RfqView = z.infer<typeof rfqViewSchema>;

/**
 * The digest an RFQ names its criteria by (`criteriaDigest`, on `RFQ_ISSUED`): SHA-256 (lowercase
 * hex) of the canonical JSON (`@rasta/sealing` `canonicalize`) of the list, in its order.
 */
export function criteriaDigest(criteria: readonly Criterion[]): string {
  const canonical = canonicalize(
    criteria.map((criterion) => ({
      code: criterion.code,
      label: criterion.label,
      weightBp: criterion.weightBp,
      scoringMethod: criterion.scoringMethod,
      maxScore: criterion.maxScore,
    })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
