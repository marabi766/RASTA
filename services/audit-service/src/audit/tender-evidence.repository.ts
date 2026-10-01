import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TENDER_EVIDENCE_CONSUMER,
  TenderEvidenceContinuityError,
  genesisReceipt,
  type AccessPayload,
  type ReceiptPayload,
} from './tender-evidence';

/** A tender has a bounded number of bids; a chain longer than this is refused, not truncated. */
export const MAX_CHAIN_LINKS = 10_000;

export type EvidenceOutcome = 'WRITTEN' | 'DUPLICATE';

export interface ChainLink {
  seq: number;
  bidId: string;
  revision: number;
  receivedAt: Date;
  ciphertextSha256: string;
  contentCommitment: string;
  previousReceipt: string;
  receipt: string;
}

/**
 * The tender-evidence tables: append-only, written by one consumer.
 *
 * Every write is one transaction with its `processed_event` marker, so an event is
 * never marked processed without its row (the invariant `AuditRepository.ingest`
 * keeps for the audit rows). A receipt link is appended under a per-tender advisory
 * lock, and only if it **continues the chain**: its predecessor is the genesis (for
 * the first link) or the current head. Nothing is accepted that does not.
 */
@Injectable()
export class TenderEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async appendLink(eventId: string, link: ReceiptPayload): Promise<EvidenceOutcome> {
    return this.prisma.client.$transaction(async (tx) => {
      const already = await tx.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName: TENDER_EVIDENCE_CONSUMER } },
        select: { eventId: true },
      });
      if (already) return 'DUPLICATE';

      // One writer per tender chain at a time; the head is read after the lock is held.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tender_evidence:${link.tenderId}`}, 0))`;
      const head = await tx.tenderReceiptLink.findFirst({
        where: { tenderId: link.tenderId },
        orderBy: { seq: 'desc' },
        select: { seq: true, receipt: true },
      });
      const expected = head?.receipt ?? genesisReceipt(link.tenderId);

      if (link.previousReceipt !== expected) {
        // Either it names a link this service has not seen (out of order, or a gap),
        // or one that already has a successor (a fork). Never accepted either way.
        const named =
          link.previousReceipt === genesisReceipt(link.tenderId)
            ? { receipt: link.previousReceipt }
            : await tx.tenderReceiptLink.findFirst({
                where: { tenderId: link.tenderId, receipt: link.previousReceipt },
                select: { receipt: true },
              });
        throw new TenderEvidenceContinuityError(named ? 'FORK' : 'GAP', eventId);
      }

      try {
        await tx.tenderReceiptLink.create({
          data: {
            tenderId: link.tenderId,
            seq: (head?.seq ?? 0) + 1,
            organizationId: link.organizationId,
            bidderOrganizationId: link.bidderOrganizationId,
            bidId: link.bidId,
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
          throw new TenderEvidenceContinuityError('FORK', eventId);
        }
        throw error;
      }

      await tx.processedEvent.create({
        data: { eventId, consumerName: TENDER_EVIDENCE_CONSUMER },
      });
      return 'WRITTEN';
    });
  }

  async recordAccess(eventId: string, access: AccessPayload): Promise<EvidenceOutcome> {
    return this.prisma.client.$transaction(async (tx) => {
      const already = await tx.processedEvent.findUnique({
        where: { eventId_consumerName: { eventId, consumerName: TENDER_EVIDENCE_CONSUMER } },
        select: { eventId: true },
      });
      if (already) return 'DUPLICATE';

      await tx.bidAccessEvidence.create({
        data: {
          sourceEventId: eventId,
          tenderId: access.tenderId,
          organizationId: access.organizationId,
          bidId: access.bidId,
          accessorOrganizationId: access.accessorOrganizationId,
          accessedBy: access.accessedBy,
          purpose: access.purpose,
          outcome: access.outcome,
          accessedAt: new Date(access.accessedAt),
        },
      });
      await tx.processedEvent.create({
        data: { eventId, consumerName: TENDER_EVIDENCE_CONSUMER },
      });
      return 'WRITTEN';
    });
  }

  /** A tender's chain in order, bounded; `null` head means "nothing announced yet". */
  async chainOf(tenderId: string): Promise<ChainLink[]> {
    const rows = await this.prisma.client.tenderReceiptLink.findMany({
      where: { tenderId },
      orderBy: { seq: 'asc' },
      take: MAX_CHAIN_LINKS + 1,
    });
    return rows.map((row) => ({
      seq: row.seq,
      bidId: row.bidId,
      revision: row.revision,
      receivedAt: row.receivedAt,
      ciphertextSha256: row.ciphertextSha256,
      contentCommitment: row.contentCommitment,
      previousReceipt: row.previousReceipt,
      receipt: row.receipt,
    }));
  }
}
