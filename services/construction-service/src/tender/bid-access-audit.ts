import { Injectable } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import type { BidAccessPurpose } from '../events/events';
import { BidRepository } from './bid.repository';

/** Who read what of a tender's bids, and why: the row and the event, never any content. */
export interface BidAccess {
  /** The tender owner's organization: the tenant the log row lives in. */
  owner: string;
  tenderId: string;
  /** Null when the read named no bid that exists for the reader. */
  bidId: string | null;
  accessorOrganizationId: string;
  accessorUserId: string;
  purpose: BidAccessPurpose;
  outcome: 'GRANTED' | 'REFUSED';
  at: Date;
}

/**
 * Every read of a bid, granted or refused, leaves a `bid_access_log` row and a
 * `BID_ACCESSED` event **in the same transaction as the read** (ADR-066 § 5): a failed
 * write fails the read. The owner's reads (opening, counting, listing, reading one) go
 * through here; the bidder's own receipt is written by `BidService`.
 */
@Injectable()
export class BidAccessAudit {
  constructor(
    private readonly bids: BidRepository,
    private readonly events: EventPublisher,
  ) {}

  async record(tx: ExtendedPrismaClient, access: BidAccess): Promise<void> {
    await this.bids.insertAccess(tx, {
      id: newId(ID_PREFIX.bidAccess),
      organizationId: access.owner,
      tenderId: access.tenderId,
      bidId: access.bidId,
      accessorOrganizationId: access.accessorOrganizationId,
      accessorUserId: access.accessorUserId,
      purpose: access.purpose,
      outcome: access.outcome,
      at: access.at,
    });
    await this.events.enqueue(tx, {
      eventName: 'BID_ACCESSED',
      aggregateId: access.tenderId,
      organizationId: access.owner,
      payload: {
        bidId: access.bidId,
        tenderId: access.tenderId,
        organizationId: access.owner,
        accessorOrganizationId: access.accessorOrganizationId,
        accessedBy: access.accessorUserId,
        purpose: access.purpose,
        outcome: access.outcome,
        accessedAt: access.at.toISOString(),
      },
      occurredAt: access.at,
    });
  }
}
