import { z } from 'zod';
import { plainText, signedAmountMinorSchema } from '@rasta/contracts';
import { AMENDMENT_STATES } from './amendment.state-machine';

/**
 * The request and response shapes of the amendment API (ADR-068 § 9, CON-003 PR 3).
 *
 * Both commands take a strict body: nothing in it decides who acts, for which side, or when.
 */

/** Longest reason text an amendment carries; the database keeps the same bound (`ck_amendment_reason`). */
export const MAX_AMENDMENT_REASON_LENGTH = 1000;

const expectedVersion = (what: string) =>
  z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `The ${what} \`version\` the caller read. When given, the command applies only to that ` +
        'version (409 OPTIMISTIC_LOCK_FAILED otherwise).',
    );

/** `POST /v1/contracts/{id}/amendments`: the employer proposes a change to the price. */
export const proposeAmendmentSchema = z
  .object({
    deltaMinor: signedAmountMinorSchema.describe(
      'The change to the contract price in minor units (rials), a decimal string; never a float. ' +
        'Within a bigint. It must be positive: no document allows a reduction yet, so zero or a ' +
        'negative amount is 422 AMENDMENT_DELTA_NOT_POSITIVE (Q-100).',
    ),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .describe(
        'One of the reasons CONTRACT_AMENDMENT_REASON_CODES names (an unlisted code is 422 ' +
          'AMENDMENT_REASON_NOT_ALLOWED).',
      ),
    reasonText: plainText()
      .min(1)
      .max(MAX_AMENDMENT_REASON_LENGTH)
      .describe(
        'Why, in the proposer’s words: trimmed, 1 to 1000 characters, without bidirectional ' +
          'control characters. Read by the two parties; never on an event.',
      ),
    expectedVersion: expectedVersion('contract’s'),
  })
  .strict();
export type ProposeAmendmentDto = z.infer<typeof proposeAmendmentSchema>;

/** `POST /v1/contracts/{id}/amendments/{amendmentId}/sign`: a party signs, for the side it acts for. */
export const signAmendmentSchema = z
  .object({ expectedVersion: expectedVersion('amendment’s') })
  .strict();
export type SignAmendmentDto = z.infer<typeof signAmendmentSchema>;

/** `GET /v1/contracts/{id}/amendments`: oldest first, a cursor being the last amendment number. */
export const listAmendmentsQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      // The amendment number is a Postgres/Prisma Int: ten digits can overflow it.
      .refine((value) => Number(value) <= 2_147_483_647, 'cursor is out of range')
      .optional()
      .describe('Opaque, server-issued.'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListAmendmentsQuery = z.infer<typeof listAmendmentsQuerySchema>;

/**
 * An amendment as either party sees it: what was proposed, who has signed (when, never by whom)
 * and, once both have, when it took effect.
 */
export const amendmentViewSchema = z
  .object({
    id: z.string(),
    contractId: z.string(),
    organizationId: z
      .string()
      .describe('The employer: the tender’s owner and the contract’s tenant.'),
    amendmentNumber: z.number().int().describe('1, 2, 3 … per contract.'),
    deltaMinor: z
      .string()
      .describe('The change to the contract price in minor units, a decimal string; positive.'),
    reasonCode: z.string(),
    reasonText: z.string(),
    status: z.enum(AMENDMENT_STATES),
    employerSignedAt: z
      .string()
      .nullable()
      .describe('When the employer signed it (ISO 8601, UTC), or null.'),
    contractorSignedAt: z
      .string()
      .nullable()
      .describe('When the winning contractor signed it (ISO 8601, UTC), or null.'),
    authorityReviewRequired: z
      .boolean()
      .describe(
        'True when the employer’s signature is flagged for review: an organization move that ' +
          'stranded the signing policy landed while it was being made (D-050). The amendment ' +
          'stays as it is — a flag is never a revocation.',
      ),
    proposedAt: z.string(),
    effectiveAt: z.string().nullable().describe('When both had signed (ISO 8601, UTC), or null.'),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type AmendmentView = z.infer<typeof amendmentViewSchema>;
