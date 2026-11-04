import { z } from 'zod';
import { plainText } from '@rasta/contracts';
import { codePointLength } from '@rasta/nest-common';
import { MAX_CONTENT_BYTES } from '@rasta/sealing';

/**
 * A quotation, as the invited supplier writes it and as it is answered (ADR-070 § 4, Q-120, Q-86;
 * the planned `QuotationContent` / `QuotationReceipt`).
 *
 * `.strict()` everywhere: the supplier, the buyer, the revision, the receipt and every instant are
 * decided by the token, the rows and the database clock, never by the body. The content is
 * structured text — a unit price in whole rials as a decimal string (money is never a float,
 * ADR-022; no currency field, Q-86), one answer per criterion of the RFQ, an optional note — and is
 * only ever stored sealed. No attachment (Q-86).
 */

export const MAX_ANSWER_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
/** One answer per criterion: an RFQ has at most 50 (`MAX_CRITERIA`). */
export const MAX_ANSWERS = 50;
/** The largest amount the platform states: a PostgreSQL `bigint` (ADR-070 § 8). */
export const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

/**
 * The ONE size budget of a quotation body, in bytes: what `quotationBodyBytes` counts. The field
 * bounds count characters, and 50 full answers can weigh far more than any layer carries (PR-605 r1
 * F1).
 *
 * A third of 256 KiB: the seal's limit, and what both parsers read (`JSON_BODY_LIMIT_BYTES`). Sealing
 * adds under a hundred bytes to the content, so a body within the budget always seals. The factor is
 * the margin for how a client may spell canonical text: every non-ASCII character as `\uXXXX` (at
 * most 3×, the default of several JSON libraries) or line endings as CRLF (2×) still fit the
 * parsers. It does not cover every spelling: padding, or ASCII written as `\uXXXX`, can pass 256 KiB
 * as sent, and is then 413, whatever it holds.
 */
export const QUOTATION_BODY_MAX_BYTES = Math.floor(MAX_CONTENT_BYTES / 3);

/**
 * The UTF-8 bytes of a parsed body as compact JSON, with JSON's escapes: exactly what a client that
 * serializes the canonical text sends, and what `canonicalize` hands the seal for each string.
 */
export function quotationBodyBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/** Static: it names the rule and never repeats the body (S-09). */
const QUOTATION_BODY_TOO_LARGE =
  `A quotation is at most ${QUOTATION_BODY_MAX_BYTES} bytes as compact JSON in UTF-8, ` +
  'counted after its text is made canonical';

/**
 * Free text in one spelling before it is length-checked and sealed: CRLF and a lone CR are LF, and
 * Unicode NFC — so the commitment to "the same note" is one commitment, whatever the client typed
 * (pre-review checklist item 16; the fleet-service rule of #372 r2 F1).
 */
export function canonicalText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

const text = (max: number) =>
  codePointLength(plainText().overwrite(canonicalText), 1, max).describe(
    `Trimmed, line endings as LF, Unicode NFC, 1 to ${max} characters, without bidirectional ` +
      'control characters.',
  );

export const quotationContentSchema = z
  .object({
    unitPriceMinor: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/, 'A unit price is a positive whole number of rials, as text')
      // Runs even when the pattern failed: must not throw on text that is not a number.
      .refine(
        (value) => /^[0-9]{1,19}$/.test(value) && BigInt(value) <= MAX_AMOUNT_MINOR,
        'The unit price is out of range',
      )
      .describe(
        'The price of one unit in rials (minor units) as a decimal string, never a float; > 0. ' +
          'Times the RFQ’s totalQuantity it must not exceed 2^63 − 1 (422 ' +
          'QUOTATION_AMOUNT_OUT_OF_RANGE, before anything is sealed or written).',
      ),
    answers: z
      .array(
        z
          .object({
            criterionCode: z.string().min(1).max(50),
            answer: text(MAX_ANSWER_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ANSWERS)
      .refine((items) => new Set(items.map((item) => item.criterionCode)).size === items.length, {
        message: 'Each criterion is answered once',
      })
      .describe(
        'One answer per criterion of the RFQ, by code (Q-120): a code the RFQ does not have is 422 ' +
          'UNKNOWN_CRITERION, a criterion left unanswered 422 CRITERION_UNANSWERED.',
      ),
    note: text(MAX_NOTE_LENGTH).optional(),
  })
  .strict();
export type QuotationContent = z.infer<typeof quotationContentSchema>;

const revision = z.number().int().min(1).max(2_147_483_647);

/** `PUT /v1/rfqs/{id}/quotations/mine`: the first seal, or the next revision of the caller's own. */
export const putQuotationSchema = z
  .object({
    expectedRevision: revision
      .optional()
      .describe(
        'Absent: the first quotation of the caller’s organization on this RFQ (409 ALREADY_EXISTS ' +
          'when it has one). Present: the `revision` the caller last read — the content replaces ' +
          'it as the next revision (409 OPTIMISTIC_LOCK_FAILED when it moved; 404 when there is ' +
          'none to revise).',
      ),
    content: quotationContentSchema.describe(
      `The whole request body is at most ${QUOTATION_BODY_MAX_BYTES} bytes: UTF-8 of its compact ` +
        'JSON, with JSON’s escapes, after the text is made canonical; above that 400 ' +
        'VALIDATION_FAILED (`too_big`), even with every field within its own bound.',
    ),
  })
  .strict()
  .superRefine((body, context) => {
    if (quotationBodyBytes(body) <= QUOTATION_BODY_MAX_BYTES) return;
    context.addIssue({
      // No field of the body is at fault. The pipe's echo backstop reads what lies under an issue's
      // path, and a whole body holds more than it reads: at the root, this message would become
      // zod's "at most N character(s)", which is wrong about the unit.
      path: ['bytes'],
      code: 'too_big',
      origin: 'string',
      maximum: QUOTATION_BODY_MAX_BYTES,
      inclusive: true,
      input: '',
      message: QUOTATION_BODY_TOO_LARGE,
    });
  });
export type PutQuotationDto = z.infer<typeof putQuotationSchema>;

/** `POST /v1/rfqs/{id}/quotations/mine/withdraw`. */
export const withdrawQuotationSchema = z
  .object({
    expectedRevision: revision.describe(
      'The `revision` the caller last read (409 OPTIMISTIC_LOCK_FAILED when it moved).',
    ),
  })
  .strict();
export type WithdrawQuotationDto = z.infer<typeof withdrawQuotationSchema>;

export const QUOTATION_STATUSES = ['SUBMITTED', 'WITHDRAWN'] as const;

/**
 * What the supplier is given back: its receipt and the state, never the content — before the
 * opening nobody reads it, the supplier included (ADR-066 § 4).
 */
export const quotationReceiptViewSchema = z
  .object({
    quotationId: z.string(),
    rfqId: z.string(),
    status: z.enum(QUOTATION_STATUSES),
    revision: z.number().int(),
    receivedAt: z
      .string()
      .describe('When the database clock received this revision (UTC, ISO 8601 with Z).'),
    contentCommitment: z
      .string()
      .describe('The salted commitment to the sealed content (hex SHA-256, ADR-066 § 3).'),
    receipt: z
      .string()
      .describe('The RFQ’s receipt chain head this revision made (hex SHA-256, ADR-066 § 3).'),
    withdrawnAt: z
      .string()
      .nullable()
      .describe('When it was withdrawn (UTC, ISO 8601 with Z), or null.'),
  })
  .strict();
export type QuotationReceiptView = z.infer<typeof quotationReceiptViewSchema>;
