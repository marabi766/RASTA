import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { PUBLICATION_REFUSALS } from './publication';

/**
 * Publishing a tender and inviting organizations to a restricted one
 * (ADR-065 § 1, § 4). `.strict()`: the owner is the token's organization, never
 * a body field, and a publication carries no data of its own — only the
 * version it is made against.
 */

const expectedVersion = z.number().int().min(1).max(2_147_483_647);

export const publishTenderSchema = z.object({ expectedVersion }).strict();

export type PublishTenderDto = z.infer<typeof publishTenderSchema>;

export const inviteBidderSchema = z
  .object({
    organizationId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe(
        'The organization invited to bid. It must exist: it is confirmed with organization-service ' +
          'before anything is written (422 INVITED_ORGANIZATION_NOT_FOUND if it does not; 503/504 ' +
          'if it cannot be confirmed, and nothing is invited unconfirmed).',
      ),
  })
  .strict();

export type InviteBidderDto = z.infer<typeof inviteBidderSchema>;

export const listInvitationsQuerySchema = cursorPaginationSchema.strict();

export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;

export const invitationViewSchema = z
  .object({
    id: z.string(),
    tenderId: z.string(),
    invitedOrganizationId: z.string(),
    invitedAt: z.string(),
    invitedBy: z.string(),
  })
  .strict();

export type InvitationView = z.infer<typeof invitationViewSchema>;

/** The closed codes a refused publication names (`publication.ts`). */
export const PUBLICATION_REFUSAL_CODES = PUBLICATION_REFUSALS;
