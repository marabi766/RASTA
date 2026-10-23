import { Injectable } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { DatabaseClock } from '../shared/clock';
import { SERVICE_NAME } from '../config/env';
import { RfqClose } from './rfq-close';
import { RfqRepository } from './rfq.repository';
import { deadlinePassed } from './rfq.state-machine';

/** What the sweep of one RFQ came to. */
export type RfqCloseResult =
  /** PUBLISHED → CLOSED here, with its RFQ_CLOSED. */
  | 'CLOSED'
  /** No longer PUBLISHED (a person closed or cancelled it): nothing written, the claim given back. */
  | 'NOOP'
  /** Not past its deadline on the clock read after the lock: the claim given back. */
  | 'NOT_DUE'
  /** The claim was taken back by another sweeper: nothing read, nothing written. */
  | 'NOT_OWNER'
  /** No such RFQ in that organization. */
  | 'NOT_FOUND';

export interface RfqCloseTarget {
  organizationId: string;
  rfqId: string;
  /** The sweeper's fencing token: verified first, so a worker whose lease lapsed does nothing. */
  fence: string;
}

/**
 * The close of one RFQ at its deadline — one short transaction, in the RFQ's own tenant (ADR-070
 * § 3; the order of the window sweep, plan PR 2): lock the RFQ `FOR UPDATE` (the lock a person's
 * close and a cancellation take, so they queue behind one another and each order has one outcome);
 * **verify the fence** before anything is read or written; read the clock after the lock; close it
 * (`RfqClose`, the command a person makes too) when it is PUBLISHED and its deadline has passed;
 * release the claim.
 *
 * Idempotent, never two events: an RFQ closed or cancelled meanwhile is NOOP, one re-claimed by
 * another sweeper is NOT_OWNER.
 */
@Injectable()
export class RfqCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: RfqRepository,
    private readonly closing: RfqClose,
    private readonly clock: DatabaseClock,
  ) {}

  close(target: RfqCloseTarget): Promise<RfqCloseResult> {
    return runWithContext(this.contextOf(target), () =>
      this.prisma.transaction((tx) => this.closeIn(tx, target)),
    );
  }

  /** A failed attempt: counted, and the next one scheduled with backoff, in the RFQ's tenant. */
  recordFailure(
    target: RfqCloseTarget,
    backoff: { baseSeconds: number; maxSeconds: number },
  ): Promise<void> {
    return runWithContext(this.contextOf(target), () =>
      this.prisma.transaction((tx) =>
        this.repository.recordFailure(tx, {
          organizationId: target.organizationId,
          id: target.rfqId,
          fence: target.fence,
          ...backoff,
        }),
      ),
    );
  }

  private contextOf(target: RfqCloseTarget) {
    return createSystemContext({
      correlationId: ulid(),
      organizationId: target.organizationId,
      callerService: SERVICE_NAME,
    });
  }

  private async closeIn(tx: ExtendedPrismaClient, target: RfqCloseTarget): Promise<RfqCloseResult> {
    const { organizationId, rfqId: id, fence } = target;
    const rfq = await this.repository.lockRfq(tx, organizationId, id);
    if (!rfq) return 'NOT_FOUND';
    // First: nothing below may run for a worker that no longer owns the claim.
    if (rfq.sweepFence !== fence) return 'NOT_OWNER';

    let result: RfqCloseResult = 'NOOP';
    if (rfq.status === 'PUBLISHED') {
      const now = await this.clock.now(tx);
      if (!deadlinePassed(rfq.quotationClosingAt, now)) {
        result = 'NOT_DUE';
      } else {
        await this.closing.close(tx, rfq, now, null);
        result = 'CLOSED';
      }
    }
    await this.repository.release(tx, rfq, fence);
    return result;
  }
}
