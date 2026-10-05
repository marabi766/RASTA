import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { CONTRACT_STATES } from './contract.state-machine';

/**
 * The request and response shapes of the contract read API (ADR-068 § 7).
 *
 * The same Zod schemas validate input, type the code and — through `zod-schema.ts` —
 * become the OpenAPI document, so the three cannot disagree. There is no body
 * anywhere: this change has no route that writes.
 */

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
