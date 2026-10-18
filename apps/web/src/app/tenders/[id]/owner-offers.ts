import type { WebSession } from '@/server/session';
import type { EvaluationMatrix } from '@/server/tender-evaluation';
import type { OwnerBids, OwnerOffer } from '@/server/tender-owner';
import { mintOwnerSubmission, type OwnerTarget } from '@/server/tender-owner-replay';

import type { OfferedOwnerCommand } from './OwnerCommands';

/** What a bid's forms are drawn with, from the matrix the page read. */
export interface OfferContext {
  readonly matrix?: EvaluationMatrix | null;
  /** The opener's view of the bids: who a bid is, when the matrix is not read. */
  readonly bids?: OwnerBids | null;
  /** The caller's user id: whose cells a scoring form starts from. */
  readonly actorId?: string | null;
}

export interface OwnerForms {
  readonly publication: OfferedOwnerCommand[];
  readonly opening: OfferedOwnerCommand[];
  readonly evaluation: OfferedOwnerCommand[];
  readonly award: OfferedOwnerCommand[];
}

/**
 * The owner's forms, each with a fresh submission whose stamp binds what the
 * page read: the tender's version for a publication, the step and its version
 * for a decision, the tender alone for the opening's three and the completion
 * of the evaluation, the bid for a bid's commands — with each criterion's
 * maximum and the revision of the caller's own cell for a score, and an
 * award's terms for an award. Which forms is `ownerOffers`, `evaluationOffers`
 * and `awardOffers`, copies of construction-service's checks.
 */
export function ownerCommandOffers(
  session: WebSession,
  tenderId: string,
  offers: readonly OwnerOffer[],
  now: number = Date.now(),
  context: OfferContext = {},
): OwnerForms {
  const forms: OwnerForms = { publication: [], opening: [], evaluation: [], award: [] };
  const mint = (target: Omit<OwnerTarget, 'tenderId'>) =>
    mintOwnerSubmission(session, { tenderId, ...target }, now);
  const bidOf = (bidId: string) => context.matrix?.bids.find((bid) => bid.bidId === bidId);
  const subjectOf = (bidId: string) =>
    bidOf(bidId)?.bidderOrganizationId ??
    context.bids?.bids.find((bid) => bid.bidId === bidId)?.bidderOrganizationId ??
    bidId;

  for (const offer of offers) {
    switch (offer.command) {
      case 'PUBLISH':
        forms.publication.push({
          command: 'PUBLISH',
          execute: offer.execute,
          submission: mint({
            command: 'PUBLISH',
            approvalId: null,
            expectedVersion: offer.expectedVersion,
          }),
        });
        break;
      case 'GRANT':
      case 'REJECT':
      case 'GRANT_AWARD':
      case 'REJECT_AWARD':
        (offer.command === 'GRANT' || offer.command === 'REJECT'
          ? forms.publication
          : forms.award
        ).push({
          command: offer.command,
          submission: mint({
            command: offer.command,
            approvalId: offer.approvalId,
            expectedVersion: offer.expectedVersion,
          }),
        });
        break;
      case 'QUALIFY':
      case 'DISQUALIFY':
        forms.evaluation.push({
          command: offer.command,
          subject: subjectOf(offer.bidId),
          scope: offer.bidId,
          submission: mint({
            command: offer.command,
            approvalId: null,
            expectedVersion: null,
            bidId: offer.bidId,
          }),
        });
        break;
      case 'SCORE': {
        const own = bidOf(offer.bidId)?.evaluations.find(
          (evaluation) => evaluation.evaluatorId === context.actorId,
        );
        const labels = new Map(
          (context.matrix?.criteria ?? []).map((criterion) => [criterion.code, criterion.label]),
        );
        forms.evaluation.push({
          command: 'SCORE',
          subject: subjectOf(offer.bidId),
          scope: offer.bidId,
          scoreRows: offer.scoring.map((cell) => ({
            cell,
            label: labels.get(cell.criterionCode) ?? cell.criterionCode,
            current:
              own?.cells.find((score) => score.criterionCode === cell.criterionCode)?.scoreScaled ??
              null,
          })),
          submission: mint({
            command: 'SCORE',
            approvalId: null,
            expectedVersion: null,
            bidId: offer.bidId,
            scoring: offer.scoring,
          }),
        });
        break;
      }
      case 'AWARD':
        forms.award.push({
          command: 'AWARD',
          execute: offer.award.execution !== null,
          subject: subjectOf(offer.bidId),
          scope: offer.bidId,
          award: offer.award,
          submission: mint({
            command: 'AWARD',
            approvalId: null,
            expectedVersion: null,
            bidId: offer.bidId,
            award: offer.award,
          }),
        });
        break;
      case 'EVALUATE':
        forms.evaluation.push({
          command: 'EVALUATE',
          submission: mint({ command: 'EVALUATE', approvalId: null, expectedVersion: null }),
        });
        break;
      default:
        forms.opening.push({
          command: offer.command,
          submission: mint({ command: offer.command, approvalId: null, expectedVersion: null }),
        });
    }
  }
  return forms;
}
