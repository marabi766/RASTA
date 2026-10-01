import { Injectable } from '@nestjs/common';
import { RastaError, createSystemContext, runWithContext } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { SYSTEM_ACTOR } from '../approval/policy-suspension.service';
import { SERVICE_NAME } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { TenderCloseRepository } from './tender-close.repository';
import { TenderClock } from './tender-clock';
import { assertTenderTransition } from './tender.state-machine';

/** What one attempt to close a tender came to. */
export type CloseResult =
  /** PUBLISHED → CLOSED, with `TENDER_CLOSED`. */
  | 'CLOSED'
  /** Not PUBLISHED any more (closed, cancelled): nothing written, no event. */
  | 'NOOP'
  /** The deadline is not yet reached on the clock read after the lock: nothing written. */
  | 'NOT_DUE'
  /** The claim was taken back by another sweeper: nothing read, nothing written. */
  | 'NOT_OWNER'
  /** No such tender in that organization. */
  | 'NOT_FOUND';

export interface CloseTarget {
  organizationId: string;
  tenderId: string;
  /**
   * The sweeper's fencing token. Present: the claim is verified first, and a worker
   * whose lease lapsed and was re-claimed does nothing. Absent: a direct close (a
   * person, or later a workflow activity), which needs no claim.
   */
  fence?: string;
}

/**
 * `close`: PUBLISHED → CLOSED once the deadline has passed (ADR-065 § 1, § 3).
 *
 * One transaction, in the order the ADR fixes: lock the tender `FOR UPDATE` (bids
 * hold it `FOR SHARE`, so a bid and the close queue behind one another and each order
 * has one outcome); **verify the fence** before anything is read or written; read the
 * decision instant from the tender clock — the database's `clock_timestamp()`, after
 * the lock, never the application's and never the transaction's start; refuse to
 * close before the deadline; compare-and-set the status; write `TENDER_CLOSED` to the
 * outbox in the same transaction.
 *
 * ## Idempotent, never two events
 *
 * A tender that is no longer PUBLISHED is `NOOP`: a second sweeper, a retry after a
 * crash between commit and acknowledgement, and a person closing it by hand all end
 * in one closed tender and one event. A claim whose lease lapsed and was re-claimed
 * is `NOT_OWNER`: the fence guards the effect, not only the claim.
 *
 * ## Why correctness does not depend on this running
 *
 * A bid is refused whenever the database's clock is at or past `bid_closing_at`,
 * even while the status is still PUBLISHED (`BidService`, and `bid_guard` as the
 * second check). This command only moves the state; if the sweeper is down, bids are
 * still refused, and the tender is closed the moment it runs again.
 */
@Injectable()
export class TenderCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly closes: TenderCloseRepository,
    private readonly events: EventPublisher,
    private readonly clock: TenderClock,
  ) {}

  /** Runs in the tender's own tenant: a system actor, the tender's organization. */
  close(target: CloseTarget, correlationId: string = ulid()): Promise<CloseResult> {
    const context = createSystemContext({
      correlationId,
      organizationId: target.organizationId,
      callerService: SERVICE_NAME,
    });
    return runWithContext(context, () =>
      withFinancialSpan(
        'construction.tender.close',
        () => this.prisma.transaction((tx) => this.closeIn(tx, target)),
        { 'rasta.tender.command': 'close' },
      ),
    ).then((result) => {
      if (result === 'CLOSED')
        tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'close' });
      return result;
    });
  }

  private async closeIn(tx: ExtendedPrismaClient, target: CloseTarget): Promise<CloseResult> {
    const { organizationId, tenderId, fence } = target;
    const locked = await this.closes.lockForClose(tx, organizationId, tenderId);
    if (!locked) return 'NOT_FOUND';

    // First: nothing below may run for a worker that no longer owns the claim.
    if (fence !== undefined && locked.fence !== fence) return 'NOT_OWNER';

    if (locked.status !== 'PUBLISHED') {
      // Closed or cancelled meanwhile: the claim, if any, is spent.
      if (fence !== undefined) await this.closes.releaseClaim(tx, organizationId, tenderId, fence);
      return 'NOOP';
    }
    assertTenderTransition(tenderId, locked.status, 'CLOSED');

    // After the lock: a long wait for it cannot leave the decision before the deadline.
    const at = await this.clock.decisionInstant(tx);
    if (!locked.bidClosingAt || at.getTime() < locked.bidClosingAt.getTime()) {
      // Not due: the deadline was moved after the claim. Give the claim back.
      if (fence !== undefined) await this.closes.releaseClaim(tx, organizationId, tenderId, fence);
      return 'NOT_DUE';
    }

    const bidCount = await this.closes.countStandingBids(tx, tenderId);
    const matched = await this.closes.closeTender(tx, {
      tenderId,
      expectedVersion: locked.version,
      actor: SYSTEM_ACTOR,
      at,
    });
    if (matched === 0) {
      versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Tender' });
      throw RastaError.optimisticLockFailed('Tender', tenderId);
    }

    await this.events.enqueue(tx, {
      eventName: 'TENDER_CLOSED',
      aggregateId: tenderId,
      organizationId,
      payload: {
        tenderId,
        projectId: locked.projectId,
        organizationId,
        bidCount,
        closedAt: at.toISOString(),
        closedBy: SYSTEM_ACTOR,
      },
      occurredAt: at,
    });
    return 'CLOSED';
  }
}
