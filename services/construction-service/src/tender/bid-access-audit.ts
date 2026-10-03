import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
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
  /** Why it was refused: a closed code (see `refusalCodeOf`); absent when granted. */
  refusalCode?: string;
  at: Date;
}

/**
 * The closed code a refusal is logged under: the first of the refusals the error names
 * (`NOT_CLOSED`, `CONFLICT_OF_INTEREST` …), else its platform error code (`NOT_FOUND`, `FORBIDDEN` …).
 * Never the message, which may name records.
 */
export function refusalCodeOf(error: unknown): string {
  if (!(error instanceof RastaError)) return 'ERROR';
  const refusals = error.internalContext?.refusals;
  const named = Array.isArray(refusals) ? refusals[0] : undefined;
  return (typeof named === 'string' && named.length > 0 ? named : error.code).slice(0, 64);
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
      refusalCode: access.outcome === 'REFUSED' ? (access.refusalCode ?? 'REFUSED') : null,
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
        refusalCode: access.outcome === 'REFUSED' ? (access.refusalCode ?? 'REFUSED') : null,
        accessedAt: access.at.toISOString(),
      },
      occurredAt: access.at,
    });
  }
}
