import { Injectable } from '@nestjs/common';
import type { SamplingSignal } from './sampling-loop';
import type { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import {
  RFQ_EVIDENCE_CONSUMER,
  RfqEvidenceContinuityError,
  RfqEvidenceIdentityError,
  genesisReceipt,
  type QuotationReceiptPayload,
} from './rfq-evidence';

/** The database's cross-state identity guard (`rfq_receipt_identity_guard`), named in its message. */
const IDENTITY_GUARD = 'ck_rfq_receipt_identity';

/** A unique violation, or the identity guard's refusal: either way a second claim on an identity. */
function isIdentityConflict(error: unknown): boolean {
  const { code, message } = error as { code?: string; message?: string };
  return code === 'P2002' || (typeof message === 'string' && message.includes(IDENTITY_GUARD));
}

/** What is compared when an event id comes back: every field the evidence is made of, canonically. */
type StoredContent = {
  rfqId: string;
  organizationId: string;
  supplierOrganizationId: string;
  quotationId: string;
  revision: number;
  receivedAt: Date;
  ciphertextSha256: string;
  contentCommitment: string;
  previousReceipt: string;
  receipt: string;
};

function sameContent(stored: StoredContent, link: QuotationReceiptPayload): boolean {
  return (
    stored.rfqId === link.rfqId &&
    stored.organizationId === link.organizationId &&
    stored.supplierOrganizationId === link.supplierOrganizationId &&
    stored.quotationId === link.quotationId &&
    stored.revision === link.revision &&
    // The column is millisecond-precise and the instant is compared as one, not as text.
    stored.receivedAt.getTime() === new Date(link.receivedAt).getTime() &&
    stored.ciphertextSha256 === link.ciphertextSha256 &&
    stored.contentCommitment === link.contentCommitment &&
    stored.previousReceipt === link.previousReceipt &&
    stored.receipt === link.receipt
  );
}

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

      // The genesis is where a chain starts, never a link in it (`genesis -> A`, then
      // `A -> genesis`, would be a cycle). Refused before anything is read or written.
      const genesis = genesisReceipt(link.rfqId);
      if (link.receipt === genesis) {
        throw new RfqEvidenceContinuityError('GENESIS_RECEIPT', eventId);
      }

      // Checked under the lock, not before it: a concurrent delivery of this same event
      // that committed while this one waited must read as a duplicate, never as a fork.
      // A DUPLICATE is an exact replay: the stored content is compared, and an event id
      // that comes back with other content is a conflict, never silently "already done".
      const already = await tx.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName: RFQ_EVIDENCE_CONSUMER } },
        select: { eventId: true },
      });
      if (already) {
        const stored =
          (await tx.rfqReceiptLink.findUnique({ where: { sourceEventId: eventId } })) ??
          (await tx.rfqReceiptPending.findUnique({ where: { sourceEventId: eventId } }));
        // A processed marker whose row is nowhere cannot be shown to be a replay: refused.
        if (stored && sameContent(stored, link)) return 'DUPLICATE';
        throw new RfqEvidenceContinuityError('CONFLICTING_REPLAY', eventId);
      }

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

      const expected = head?.receipt ?? genesis;

      // One identity across both states: a receipt, or a successor of this predecessor, that
      // is already placed OR held (under any other event) is a fork, whichever of the two
      // arrived first. The database refuses the same pair (`rfq_receipt_identity_guard`).
      const claimed = {
        rfqId: link.rfqId,
        OR: [{ receipt: link.receipt }, { previousReceipt: link.previousReceipt }],
      };
      if (
        (await tx.rfqReceiptLink.findFirst({ where: claimed, select: { receipt: true } })) ||
        (await tx.rfqReceiptPending.findFirst({ where: claimed, select: { receipt: true } }))
      ) {
        throw new RfqEvidenceContinuityError('FORK', eventId);
      }

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
      if (known) throw new RfqEvidenceContinuityError('FORK', eventId);

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
        if (isIdentityConflict(error)) {
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
      if (isIdentityConflict(error)) {
        throw new RfqEvidenceContinuityError('FORK', eventId);
      }
      throw error;
    }
  }

  /**
   * Moves held receipts into the chain, oldest link first, for as long as one continues
   * it. Moving a held row is moving **the same event** (same `sourceEventId`): if the chain
   * already holds that receipt under *another* event, the held one is a conflicting claim and
   * is left held (an overdue gap, loud) — never accepted, never dropped silently, and it does
   * not block the legitimate link whose arrival triggered the drain. (Admission refuses such a
   * pair, and the database guard does too; this is the last line.)
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
        select: { sourceEventId: true, seq: true },
      });
      if (placed) {
        if (placed.sourceEventId !== next.sourceEventId) return;
        // Already moved (this very event): only the held copy remains, and it goes.
        await tx.rfqReceiptPending.delete({ where: { sourceEventId: next.sourceEventId } });
        receipt = next.receipt;
        seq = placed.seq;
        continue;
      }

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
  async pendingSummary(
    olderThanSeconds: number,
    signal: SamplingSignal,
  ): Promise<{
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
    // The first query may have outlived the shutdown deadline: no second query then.
    signal.throwIfAbandoned();
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
