import type { WebSession } from '@/server/session';
import type { OwnerOffer } from '@/server/tender-owner';
import { mintOwnerSubmission } from '@/server/tender-owner-replay';

import type { OfferedOwnerCommand } from './OwnerCommands';

/**
 * The owner's forms, each with a fresh submission whose stamp binds what the
 * page read: the tender's version for a publication, the step and its version
 * for a decision, the tender alone for the opening's three. Which forms is
 * `ownerOffers`, a copy of construction-service's checks.
 */
export function ownerCommandOffers(
  session: WebSession,
  tenderId: string,
  offers: readonly OwnerOffer[],
  now: number = Date.now(),
): { readonly publication: OfferedOwnerCommand[]; readonly opening: OfferedOwnerCommand[] } {
  const publication: OfferedOwnerCommand[] = [];
  const opening: OfferedOwnerCommand[] = [];
  for (const offer of offers) {
    switch (offer.command) {
      case 'PUBLISH':
        publication.push({
          command: 'PUBLISH',
          execute: offer.execute,
          submission: mintOwnerSubmission(
            session,
            {
              tenderId,
              command: 'PUBLISH',
              approvalId: null,
              expectedVersion: offer.expectedVersion,
            },
            now,
          ),
        });
        break;
      case 'GRANT':
      case 'REJECT':
        publication.push({
          command: offer.command,
          submission: mintOwnerSubmission(
            session,
            {
              tenderId,
              command: offer.command,
              approvalId: offer.approvalId,
              expectedVersion: offer.expectedVersion,
            },
            now,
          ),
        });
        break;
      default:
        opening.push({
          command: offer.command,
          submission: mintOwnerSubmission(
            session,
            { tenderId, command: offer.command, approvalId: null, expectedVersion: null },
            now,
          ),
        });
    }
  }
  return { publication, opening };
}
