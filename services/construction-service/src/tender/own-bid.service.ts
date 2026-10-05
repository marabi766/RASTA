import { Injectable, Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { Bid, Tender } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ProjectAccess } from '../access/access';
import { transactionNow } from '../shared/clock';
import { BidAccessAudit, refusalCodeOf } from './bid-access-audit';
import { BidContentReader } from './bid-content-reader';
import { BidRepository } from './bid.repository';
import { buildMatrix, maxTotalScaled } from './evaluation-matrix';
import type { OwnEvaluationView } from './evaluation.dto';
import type { OwnOpenedBidView } from './bid.dto';
import { ruleRefusal } from '../shared/refusal';

const OWN_BID_CONTENT = 'OWN_BID_CONTENT';

/** A bid that was never opened is not read: a standing bid is opened with the tender, a withdrawn one never is. */
const NOT_OPENED_STATES: readonly string[] = ['SUBMITTED', 'WITHDRAWN'];

/**
 * A contractor reading **its own** bid after the opening (ADR-066 § 4, carried over from the
 * opening step): the content it sealed, its status, and what the evaluation says of it.
 *
 * ## Tenant-scoped by construction
 *
 * The bid is found by the caller's organization (`bidder_organization_id`) on the tender, so the
 * route names no bid at all and there is no way to ask for another contractor's. Every
 * evaluation row read is keyed by that one bid's id. The content is the bytes the contractor
 * sealed, opened against **audit-service's** receipts (`BidContentReader`, the same check the
 * owner's reads make: a chain or a bid that differs from the evidence is 422 `INTEGRITY`,
 * audit-service unreachable is 503/504, never answered from this service's own copy).
 *
 * ## What the evaluation shows (Q-89)
 *
 * The decision on the bid once it is made (a disqualification's closed reason code, not the words
 * the evaluator wrote), and — only once the evaluation is completed — its own total and the most a
 * bid can score. No rank, no other bidder, no winner, no amount.
 *
 * ## Audited like every read of a bid (ADR-066 § 5)
 *
 * A row in the tender owner's `bid_access_log` and `BID_ACCESSED` (`OWN_BID_CONTENT`, with the
 * outcome) in the same transaction as the read; a refused read — no bid of the caller on the
 * tender (404), the bid not opened (422 `NOT_OPENED`), the evidence not there — commits its REFUSED
 * row (with the closed code) and then answers. A failed write of the log fails the read.
 */
@Injectable()
export class OwnBidService {
  private readonly logger = new Logger(OwnBidService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bids: BidRepository,
    private readonly reader: BidContentReader,
    private readonly audit: BidAccessAudit,
    private readonly access: ProjectAccess,
  ) {}

  async getMineOpened(tenderId: string): Promise<OwnOpenedBidView> {
    const { organizationId: bidder, actor } = this.access.assertCanBid();

    // What is asked before any evidence is: does the caller have a bid, and has it been opened?
    const first = await this.prisma.transaction(async (tx) => {
      const tender = await this.bids.findTenderRow(tx, tenderId);
      // A tender that does not exist has no owner whose log could hold the attempt.
      if (!tender) return null;
      const bid = await this.bids.findBidOf(tx, tenderId, bidder);
      const refusal = !bid
        ? RastaError.notFound('Bid', tenderId)
        : tender.openedAt === null || NOT_OPENED_STATES.includes(bid.status)
          ? ruleRefusal('Bids are not opened: NOT_OPENED', 'opening', ['NOT_OPENED'])
          : null;
      if (refusal) {
        await this.log(
          tx,
          tender,
          bid?.id ?? null,
          bidder,
          actor,
          'REFUSED',
          refusal,
          await transactionNow(tx),
        );
        return { tender, refusal };
      }
      return { tender, refusal: null };
    });
    if (!first) throw RastaError.notFound('Bid', tenderId);
    if (first.refusal) throw first.refusal;

    try {
      // Outside the transaction and before the lock: it must not hold the tender while it waits on a network.
      const evidence = await this.reader.readEvidence(first.tender.organizationId, tenderId);
      return await withFinancialSpan(
        'construction.bid.read-own',
        () =>
          this.prisma.transaction(async (tx) => {
            // Shared: queues behind an owner command in progress and sees it whole or not at all.
            await this.bids.lockTenderShared(tx, tenderId);
            const tender = await this.bids.findTenderRow(tx, tenderId);
            const bid = await this.bids.findBidOf(tx, tenderId, bidder);
            if (!tender || !bid) throw RastaError.notFound('Bid', tenderId);
            if (tender.openedAt === null || NOT_OPENED_STATES.includes(bid.status)) {
              throw ruleRefusal('Bids are not opened: NOT_OPENED', 'opening', ['NOT_OPENED']);
            }
            const at = await transactionNow(tx);

            const key = await this.bids.findWrappedKey(tx, tenderId);
            let content: OwnOpenedBidView['content'] | undefined;
            this.reader.withPrivateKey(key, tenderId, (privateKey, keyId) => {
              content = this.reader.openOne(privateKey, keyId, tenderId, bid, evidence.receipts);
            });
            if (!content) throw RastaError.internal('A bid was not opened');

            const evaluation = await this.evaluationOf(tx, tender, bid);
            await this.log(tx, tender, bid.id, bidder, actor, 'GRANTED', null, at);
            return {
              bidId: bid.id,
              tenderId,
              status: bid.status,
              revision: bid.revision,
              receivedAt: bid.receivedAt.toISOString(),
              contentCommitment: bid.contentCommitment,
              content,
              evaluation,
            };
          }),
        { 'rasta.tender.command': 'bid-read-own' },
      );
    } catch (error) {
      // The evidence is not there, the bid does not verify, the key is unavailable: logged, then answered.
      if (error instanceof RastaError) {
        await this.recordRefusal(first.tender, bidder, actor, error);
      }
      throw error;
    }
  }

  /** What the evaluation says of this bid, for its own bidder: the decision, and the total once completed. */
  private async evaluationOf(
    tx: ExtendedPrismaClient,
    tender: Tender,
    bid: Bid,
  ): Promise<OwnEvaluationView> {
    const qualification = await this.bids.findQualificationOf(tx, tender.id, bid.id);
    const completed = tender.evaluatedAt !== null;
    const decision = qualification?.decision ?? null;
    const reasonCode = (qualification?.reasonCode ?? null) as OwnEvaluationView['reasonCode'];
    if (!completed || decision !== 'QUALIFIED' || !qualification) {
      return {
        decision,
        reasonCode,
        completed,
        totalScaled: null,
        maxTotalScaled: null,
        evaluatorCount: null,
      };
    }
    const criteria = await this.bids.listCriteria(tx, tender.id);
    const { evaluations, recusals, scores } = await this.bids.evaluationOf(tx, tender.id, bid.id);
    // The matrix of this one bid, from its own rows alone: nothing of any other bid is in it.
    const matrix = buildMatrix({
      tenderId: tender.id,
      status: tender.status,
      frozen: true,
      criteria,
      bids: [{ id: bid.id, bidderOrganizationId: bid.bidderOrganizationId, status: bid.status }],
      qualifications: [
        {
          bidId: bid.id,
          decision: 'QUALIFIED',
          reasonCode: null,
          reasonText: null,
          decidedBy: qualification.decidedBy,
          decidedAt: qualification.decidedAt,
        },
      ],
      evaluations,
      recusals,
      scores,
      minEvaluators: 1,
      maxEvaluators: 1,
    });
    const own = matrix.bids[0];
    return {
      decision,
      reasonCode,
      completed,
      totalScaled: own?.totalScaled ?? null,
      maxTotalScaled: maxTotalScaled(criteria).toString(),
      evaluatorCount: own?.evaluatorCount ?? null,
    };
  }

  /** The row and `BID_ACCESSED` of a read of the bidder's own bid, in the caller's transaction. */
  private async log(
    tx: ExtendedPrismaClient,
    tender: Tender,
    bidId: string | null,
    bidder: string,
    actor: string,
    outcome: 'GRANTED' | 'REFUSED',
    refusal: RastaError | null,
    at: Date,
  ): Promise<void> {
    await this.audit.record(tx, {
      owner: tender.organizationId,
      tenderId: tender.id,
      bidId,
      accessorOrganizationId: bidder,
      accessorUserId: actor,
      purpose: OWN_BID_CONTENT,
      outcome,
      ...(refusal ? { refusalCode: refusalCodeOf(refusal) } : {}),
      at,
    });
  }

  /** A refusal after the first look, in a transaction of its own. Best effort: it never replaces the answer. */
  private async recordRefusal(
    tender: Tender,
    bidder: string,
    actor: string,
    error: RastaError,
  ): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        const bid = await this.bids.findBidOf(tx, tender.id, bidder);
        await this.log(
          tx,
          tender,
          bid?.id ?? null,
          bidder,
          actor,
          'REFUSED',
          error,
          await transactionNow(tx),
        );
      });
    } catch (cause) {
      this.logger.error(
        `could not record a refused read of an own bid: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }
}
