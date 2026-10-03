import { Injectable, Logger } from '@nestjs/common';
import { RastaError, createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { SERVICE_NAME } from '../config/env';
import { awardStandingChecksTotal } from '../observability/metrics';
import { AwardStandingCheckRepository, type ClaimedCheck } from './award-standing-check.repository';
import { StandingAuthority } from './standing-authority';

/** What one attempt at a standing check came to. */
export type StandingCheckResult =
  /** The winner was not suspended, nor its qualification removed, in the window: DONE. */
  | 'CLEAR'
  /** It may have been: DONE, `TENDER_AWARD_STANDING_CONFLICT_DETECTED` written in the same transaction. */
  | 'CONFLICT'
  /** supplier-service could not say: counted, the claim given back, retried after a backoff. */
  | 'RETRY'
  /** The claim was taken back by another sweeper (or the check is settled): nothing was written. */
  | 'LOST';

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. Never a message. */
export function closedCodeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}

/**
 * The standing check that follows every award (ADR-067 § 3, residual). No lock spans
 * supplier-service and this service, so a suspension that lands between the answer the award was
 * made on and its commit is not stopped. This is the detective control: supplier-service is asked
 * again over the window `[windowStart, its own clock as it answers]` — `windowStart` being the
 * instant of the standing read the award was made on — and a suspension that began inside it (even
 * one that has ended), one still open, or a removed contracting qualification is a **possible**
 * conflict, conservative on purpose (a false positive is an alert and nothing more).
 *
 * ## Durable, and exactly once
 *
 * The check is a row written in the award's own transaction (`tender_award_standing_check`; the
 * database refuses to commit an award without it), so a crash after the commit loses nothing, and
 * the response of `award` waits for nothing. `AwardStandingCheckSweeper` claims it under a lease and
 * a fencing token. The network call is made outside any transaction; the outcome is then written in
 * **one** transaction under the fence — the row goes DONE, and on a conflict
 * `TENDER_AWARD_STANDING_CONFLICT_DETECTED` is enqueued in the same commit — so a retry after a
 * crash, a second sweeper and a lapsed lease never produce a second event, and never lose one. The
 * award is not undone; a person decides (runbook `award-standing-conflict`).
 *
 * ## Failures name the award
 *
 * Every line logged here carries the tender id, the winning bid id and a closed error code, so a
 * signal can be tied to its award; never an amount, a name or a message.
 */
@Injectable()
export class AwardStandingCheckService {
  private readonly logger = new Logger(AwardStandingCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: AwardStandingCheckRepository,
    private readonly events: EventPublisher,
    private readonly standing: StandingAuthority,
  ) {}

  /** One attempt at one claimed check. A throw is the sweeper's to record (it names the award). */
  async process(
    claim: ClaimedCheck,
    backoff: { baseSeconds: number; maxSeconds: number },
  ): Promise<StandingCheckResult> {
    let report;
    try {
      report = await this.standing.windowReport(claim.winnerOrganizationId, claim.windowStart);
    } catch (error) {
      awardStandingChecksTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
      this.logger.warn(
        `${describe(claim)}: supplier-service could not say (${closedCodeOf(error)}); retried after a backoff`,
      );
      await this.recordFailure(claim, backoff);
      return 'RETRY';
    }

    const conflict = report.suspensionCount > 0 || report.qualificationRemoved;
    const settledAt = await this.inTenant(claim.organizationId, () =>
      this.prisma.transaction(async (tx) => {
        const at = await this.checks.settle(tx, {
          organizationId: claim.organizationId,
          id: claim.id,
          fence: claim.fence,
          outcome: conflict ? 'CONFLICT' : 'CLEAR',
        });
        if (at === null) return null;
        if (conflict) {
          await this.events.enqueue(tx, {
            eventName: 'TENDER_AWARD_STANDING_CONFLICT_DETECTED',
            aggregateId: claim.tenderId,
            organizationId: claim.organizationId,
            payload: {
              tenderId: claim.tenderId,
              projectId: claim.projectId,
              organizationId: claim.organizationId,
              winningBidId: claim.bidId,
              winnerOrganizationId: claim.winnerOrganizationId,
              awardedBy: claim.awardedBy,
              awardedAt: claim.awardedAt.toISOString(),
              windowStart: claim.windowStart.toISOString(),
              checkedAt: report.checkedAt.toISOString(),
              suspensionIds: report.suspensionIds,
              suspensionCount: report.suspensionCount,
              qualificationRemoved: report.qualificationRemoved,
            },
            occurredAt: at,
          });
        }
        return at;
      }),
    );
    if (settledAt === null) {
      this.logger.warn(
        `${describe(claim)}: the claim was taken back before the outcome was written`,
      );
      return 'LOST';
    }
    // Counted once the outcome is in the database: the event is already durable, this is the page.
    awardStandingChecksTotal.inc({
      service: SERVICE_NAME,
      outcome: conflict ? 'conflict' : 'clear',
    });
    if (conflict) {
      this.logger.error(
        `${describe(claim)}: the winner may have been suspended, or no longer qualified, in the window around the award; TENDER_AWARD_STANDING_CONFLICT_DETECTED written (${report.suspensionCount} suspension(s), qualification removed: ${report.qualificationRemoved})`,
      );
    }
    return conflict ? 'CONFLICT' : 'CLEAR';
  }

  /** The attempt failed in a way that is not "supplier-service could not say": count it and back off. Best effort. */
  async recordFailure(
    claim: ClaimedCheck,
    backoff: { baseSeconds: number; maxSeconds: number },
  ): Promise<void> {
    try {
      await this.inTenant(claim.organizationId, () =>
        this.prisma.transaction((tx) =>
          this.checks.recordFailure(tx, {
            organizationId: claim.organizationId,
            id: claim.id,
            fence: claim.fence,
            ...backoff,
          }),
        ),
      );
    } catch (error) {
      // The lease running out is the fallback retry.
      this.logger.warn(
        `${describe(claim)}: recording the failed attempt failed (${closedCodeOf(error)})`,
      );
    }
  }

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return runWithContext(
      createSystemContext({
        correlationId: ulid(),
        organizationId,
        callerService: SERVICE_NAME,
      }),
      fn,
    );
  }
}

/** Which award a log line is about: the tender and the winning bid, ids only. */
export function describe(claim: Pick<ClaimedCheck, 'tenderId' | 'bidId'>): string {
  return `Standing check after the award of tender ${claim.tenderId} (winning bid ${claim.bidId})`;
}
