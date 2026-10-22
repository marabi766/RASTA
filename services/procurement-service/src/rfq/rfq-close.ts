import { Injectable } from '@nestjs/common';
import type { Rfq } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { RfqRepository } from './rfq.repository';

/**
 * PUBLISHED → CLOSED with its `RFQ_CLOSED` (ADR-070 § 3): the one transition the close sweeper and a
 * person of the buyer both make — the same command, so they cannot disagree on what a close is.
 *
 * The caller holds the RFQ's lock and has judged, on the database clock read after it, that the
 * deadline has passed; `rfq_guard` refuses a close before `quotation_closing_at` on the database's
 * own clock, whatever writes it.
 * `closedBy` is the person, or null for the sweeper.
 */
@Injectable()
export class RfqClose {
  constructor(
    private readonly repository: RfqRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async close(
    tx: ExtendedPrismaClient,
    rfq: Rfq,
    now: Date,
    closedBy: string | null,
  ): Promise<Rfq> {
    const closed = await this.repository.moveRfq(tx, rfq, 'CLOSED', {
      closedAt: now,
      closedBy,
      updatedAt: now,
    });
    await this.publisher.enqueue(tx, {
      eventName: 'RFQ_CLOSED',
      aggregateId: rfq.id,
      organizationId: rfq.organizationId,
      occurredAt: now,
      payload: {
        rfqId: rfq.id,
        organizationId: rfq.organizationId,
        aggregationId: rfq.aggregationId,
        rfqVersion: closed.version,
        quotationClosingAt: rfq.quotationClosingAt.toISOString(),
        trigger: closedBy === null ? 'SWEEPER' : 'MANUAL',
        closedBy,
        closedAt: now.toISOString(),
        // ADR-070 § 9: the sealed quotations it holds at its close. None exist before quotations
        // arrive (plan PR 8), which counts them here.
        quotationCount: 0,
      },
    });
    return closed;
  }
}
