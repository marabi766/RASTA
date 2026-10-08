import { z } from 'zod';
import { cursorPaginationSchema, plainText } from '@rasta/contracts';
import { CONTRACT_STATES } from './contract.state-machine';

/**
 * The request and response shapes of the contract API (ADR-068 § 7; sign and cancel, PR 2).
 *
 * The same Zod schemas validate input, type the code and — through `zod-schema.ts` —
 * become the OpenAPI document, so the three cannot disagree. Both commands take a strict
 * body: nothing in it decides who acts, for which side, or when.
 */

const expectedVersion = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    'The `version` the caller read. When given, the command applies only to that version ' +
      '(409 OPTIMISTIC_LOCK_FAILED otherwise). A draft’s version moves only with its status: ' +
      'the terms it is signed on never change, and a signature does not move it.',
  );

/** `POST /v1/contracts/{id}/sign`: accept the draft for the side the caller acts for. */
export const signContractSchema = z.object({ expectedVersion }).strict();
export type SignContractDto = z.infer<typeof signContractSchema>;

/** Longest note a cancellation carries; the database keeps the same bound (`ck_contract_cancellation`). */
export const MAX_CANCEL_NOTE_LENGTH = 1000;

/** `POST /v1/contracts/{id}/cancel`: the employer ends a draft, for a reason from a closed list. */
export const cancelContractSchema = z
  .object({
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .describe(
        'One of the reasons CONTRACT_CANCEL_REASON_CODES names (the closed list is the ' +
          'client’s; an unlisted code is 422 CANCEL_REASON_NOT_ALLOWED).',
      ),
    note: plainText()
      .min(1)
      .max(MAX_CANCEL_NOTE_LENGTH)
      .optional()
      .describe(
        'Optional free text, trimmed, up to 1000 characters, without bidirectional ' +
          'control characters. Read by the two parties; never on an event.',
      ),
    expectedVersion,
  })
  .strict();
export type CancelContractDto = z.infer<typeof cancelContractSchema>;

export const listContractsQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(CONTRACT_STATES).optional(),
  })
  .strict();

export type ListContractsQuery = z.infer<typeof listContractsQuerySchema>;

/**
 * A contract as either of its two parties sees it: the employer (the tender's owner)
 * and the winning contractor. The same fields for both, and only what a party to the
 * contract may know of the other: who awarded it, the digest of the evaluation it was
 * awarded on, and who made the draft stay in this service's database for audit.
 */
export const contractViewSchema = z
  .object({
    id: z.string(),
    organizationId: z
      .string()
      .describe('The employer: the tender’s owner and the contract’s tenant.'),
    tenderId: z.string(),
    projectId: z.string(),
    winningBidId: z.string(),
    contractorOrganizationId: z.string().describe('The winning contractor.'),
    amountMinor: z
      .string()
      .describe(
        'The contract amount in minor units (rials), a decimal string; never a float. It is ' +
          'the winning bid’s price as construction-service states it, with no adjustment (Q-95 (5)).',
      ),
    status: z.enum(CONTRACT_STATES),
    employerSignedAt: z
      .string()
      .nullable()
      .describe('When the employer accepted the draft (ISO 8601, UTC), or null.'),
    contractorSignedAt: z
      .string()
      .nullable()
      .describe('When the winning contractor accepted the draft (ISO 8601, UTC), or null.'),
    authorityReviewRequired: z
      .boolean()
      .describe(
        'True when the employer’s signature is flagged for review: an organization move that ' +
          'stranded the signing policy landed while it was being made (D-050). The contract stays ' +
          'as it is — a flag is never a revocation or a cancellation.',
      ),
    authorityReviewReason: z
      .literal('AUTHORITY_CHANGED_DURING_SIGNING')
      .nullable()
      .describe('The closed reason of the flag, or null when there is none.'),
    cancelReasonCode: z
      .string()
      .nullable()
      .describe('Why the employer cancelled the draft: a code from the closed list, or null.'),
    cancelNote: z
      .string()
      .nullable()
      .describe('The optional note that came with the cancellation.'),
    awardedAt: z.string().describe('When the tender was awarded (ISO 8601, UTC).'),
    statusChangedAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();

export type ContractView = z.infer<typeof contractViewSchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
