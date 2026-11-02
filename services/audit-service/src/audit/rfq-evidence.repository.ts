import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import {
  RFQ_EVIDENCE_CONSUMER,
  RfqEvidenceContinuityError,
  RfqEvidenceIdentityError,
  genesisReceipt,
  type QuotationReceiptPayload,
} from './rfq-evidence';

/** An RFQ has a bounded number of quotations; a chain longer than this is refused, not truncated. */
export const MAX_CHAIN_LINKS = 10_000;

/** `HELD`: the predecessor has not arrived; the receipt waits for it, durably. */
export type EvidenceOutcome = 'WRITTEN' | 'DUPLICATE' | 'HELD';

export interface ChainLink {
  seq: number;
  quotationId: string;
  revision: number;
  receivedAt: Date;
  ciphertextSha256: string;
  contentCommitment: string;
  previousReceipt: string;
  receipt: string;
}

/**
 * The RFQ-evidence tables: append-only, written by one consumer.
 *
 * Every write is one transaction with its `processed_event` marker, so an event is
 * never marked processed without its row (the invariant `AuditRepository.ingest`
 * keeps for the audit rows). A receipt link is appended under a per-RFQ advisory
 * lock, and only if it **continues the chain**: its predecessor is the genesis (for
 * the first link) or the current head. Nothing is accepted that does not.
 */
@Injectable()
export class RfqEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends a link, or holds it, or recognises it.
   *
   * - Its predecessor is the head (or the genesis, for the first): appended, and every
   *   held successor that now continues the chain is drained **in order, in this same
   *   transaction**.
   * - Its predecessor is a link already recorded but not the head, or the genesis once
   *   a first link exists, or its receipt is already recorded: a fork, refused.
   * - Its predecessor has not arrived (the relay orders events only inside one claimed
   *   batch, so a later receipt can reach the topic first): **held**, durably, never
   *   dead-lettered. The event is marked processed with the held row, so a redelivery
   *   is a duplicate; it is placed when its predecessor is appended.
   */
  async appendLink(eventId: string, link: QuotationReceiptPayload): Promise<EvidenceOutcome> {
    return this.prisma.client.$transaction(async (tx) => {
      // One writer per RFQ chain at a time; the head is read after the lock is held.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rfq_evidence:${link.rfqId}`}, 0))`;

      // Checked under the lock, not before it: a concurrent delivery of this same event
      // that committed while this one waited must read as a duplicate, never as a fork.
      const already = await tx.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName: RFQ_EVIDENCE_CONSUMER } },
        select: { eventId: true },
      });
      if (already) return 'DUPLICATE';

      const head = await tx.rfqReceiptLink.findFirst({
        where: { rfqId: link.rfqId },
        orderBy: { seq: 'desc' },
        select: { seq: true, receipt: true, organizationId: true },
      });

      // An RFQ belongs to one organization: a chain (or a held receipt) under
      // another is never extended by this one.
      const owner =
        head?.organizationId ??
        (
          await tx.rfqReceiptPending.findFirst({
            where: { rfqId: link.rfqId },
            select: { organizationId: true },
          })
        )?.organizationId;
      if (owner !== undefined && owner !== link.organizationId) {
        throw new RfqEvidenceIdentityError('QUOTATION_RECEIPT', eventId, 'organization');
      }

      const genesis = genesisReceipt(link.rfqId);
      const expected = head?.receipt ?? genesis;

      if (link.previousReceipt === expected) {
        await this.insertLink(tx, eventId, link, (head?.seq ?? 0) + 1);
        await this.drain(tx, link.rfqId, link.receipt, (head?.seq ?? 0) + 1);
        await tx.processedEvent.create({
          data: { eventId, consumerName: RFQ_EVIDENCE_CONSUMER },
        });
        return 'WRITTEN';
      }

      // Not the head: either a link recorded already (a fork), or one not seen yet.
      const known =
        link.previousReceipt === genesis
          ? { receipt: genesis }
          : await tx.rfqReceiptLink.findFirst({
              where: { rfqId: link.rfqId, receipt: link.previousReceipt },
              select: { receipt: true },
            });
      const duplicate = await tx.rfqReceiptLink.findFirst({
        where: { rfqId: link.rfqId, receipt: link.receipt },
        select: { receipt: true },
      });
      if (known || duplicate) throw new RfqEvidenceContinuityError('FORK', eventId);

      try {
        await tx.rfqReceiptPending.create({
          data: {
            sourceEventId: eventId,
            rfqId: link.rfqId,
            organizationId: link.organizationId,
            supplierOrganizationId: link.supplierOrganizationId,
            quotationId: link.quotationId,
            revision: link.revision,
            receivedAt: new Date(link.receivedAt),
            ciphertextSha256: link.ciphertextSha256,
            contentCommitment: link.contentCommitment,
            previousReceipt: link.previousReceipt,
            receipt: link.receipt,
          },
        });
      } catch (error) {
        // A second held successor of one predecessor, or the same receipt held twice.
        if ((error as { code?: string }).code === 'P2002') {
          throw new RfqEvidenceContinuityError('FORK', eventId);
        }
        throw error;
      }
      await tx.processedEvent.create({
        data: { eventId, consumerName: RFQ_EVIDENCE_CONSUMER },
      });
      return 'HELD';
    });
  }

  private async insertLink(
    tx: Prisma.TransactionClient,
    eventId: string,
    link: QuotationReceiptPayload,
    seq: number,
  ): Promise<void> {
    try {
      await tx.rfqReceiptLink.create({
        data: {
          rfqId: link.rfqId,
          seq,
          organizationId: link.organizationId,
          supplierOrganizationId: link.supplierOrganizationId,
          quotationId: link.quotationId,
          revision: link.revision,
          receivedAt: new Date(link.receivedAt),
          ciphertextSha256: link.ciphertextSha256,
          contentCommitment: link.contentCommitment,
          previousReceipt: link.previousReceipt,
          receipt: link.receipt,
          sourceEventId: eventId,
        },
      });
    } catch (error) {
      // The same receipt under another event, or a second successor: a fork.
      if ((error as { code?: string }).code === 'P2002') {
        throw new RfqEvidenceContinuityError('FORK', eventId);
      }
      throw error;
    }
  }

  /**
   * Moves held receipts into the chain, oldest link first, for as long as one continues
   * it. A held receipt whose receipt is already in the chain is left held (and so
   * becomes an overdue gap): it must neither be dropped silently nor block the legitimate
   * link whose arrival triggered the drain.
   */
  private async drain(
    tx: Prisma.TransactionClient,
    rfqId: string,
    headReceipt: string,
    headSeq: number,
  ): Promise<void> {
    let receipt = headReceipt;
    let seq = headSeq;
    for (let guard = 0; guard < MAX_CHAIN_LINKS; guard += 1) {
      const next = await tx.rfqReceiptPending.findFirst({
        where: { rfqId, previousReceipt: receipt },
      });
      if (!next) return;
      const placed = await tx.rfqReceiptLink.findFirst({
        where: { rfqId, receipt: next.receipt },
        select: { receipt: true },
      });
      if (placed) return;

      seq += 1;
      await this.insertLink(
        tx,
        next.sourceEventId,
        {
          quotationId: next.quotationId,
          rfqId: next.rfqId,
          organizationId: next.organizationId,
          supplierOrganizationId: next.supplierOrganizationId,
          revision: next.revision,
          receivedAt: next.receivedAt.toISOString(),
          contentCommitment: next.contentCommitment,
          ciphertextSha256: next.ciphertextSha256,
          previousReceipt: next.previousReceipt,
          receipt: next.receipt,
        },
        seq,
      );
      await tx.rfqReceiptPending.delete({ where: { sourceEventId: next.sourceEventId } });
      receipt = next.receipt;
    }
  }

  /**
   * What the gauges report, counted over **all** held rows: how many are held, how many
   * for longer than `olderThanSeconds`, and the age of the oldest. `newlyOverdue` lists
   * (at most 1000, oldest first) the overdue receipts' event ids, only for the monitor
   * to count each new gap once; it is never what the gauges are computed from.
   */
  async pendingSummary(olderThanSeconds: number): Promise<{
    held: number;
    overdueCount: number;
    oldestAgeSeconds: number;
    newlyOverdue: string[];
  }> {
    const [totals] = await this.prisma.client.$queryRaw<
      { held: bigint; overdue: bigint; oldest: number | null }[]
    >`SELECT count(*) AS held,
             count(*) FILTER (WHERE clock_timestamp() - held_at >= make_interval(secs => ${olderThanSeconds})) AS overdue,
             EXTRACT(EPOCH FROM (clock_timestamp() - min(held_at)))::float8 AS oldest
        FROM rfq_receipt_pending`;
    const rows = await this.prisma.client.$queryRaw<{ source_event_id: string }[]>`
      SELECT source_event_id FROM rfq_receipt_pending
       WHERE clock_timestamp() - held_at >= make_interval(secs => ${olderThanSeconds})
       ORDER BY held_at ASC LIMIT 1000`;
    return {
      held: Number(totals?.held ?? 0n),
      overdueCount: Number(totals?.overdue ?? 0n),
      oldestAgeSeconds: totals?.oldest == null ? 0 : Math.max(0, Math.floor(totals.oldest)),
      newlyOverdue: rows.map((row) => row.source_event_id),
    };
  }

  /** An RFQ's chain in order, bounded; `null` head means "nothing announced yet". */
  async chainOf(organizationId: string, rfqId: string): Promise<ChainLink[]> {
    const rows = await this.prisma.client.rfqReceiptLink.findMany({
      where: { organizationId, rfqId },
      orderBy: { seq: 'asc' },
      take: MAX_CHAIN_LINKS + 1,
    });
    return rows.map((row) => ({
      seq: row.seq,
      quotationId: row.quotationId,
      revision: row.revision,
      receivedAt: row.receivedAt,
      ciphertextSha256: row.ciphertextSha256,
      contentCommitment: row.contentCommitment,
      previousReceipt: row.previousReceipt,
      receipt: row.receipt,
    }));
  }
}
