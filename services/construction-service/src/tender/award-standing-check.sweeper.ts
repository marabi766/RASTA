import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { awardStandingChecksTotal } from '../observability/metrics';
import { AwardStandingCheckRepository } from './award-standing-check.repository';
import {
  AwardStandingCheckService,
  closedCodeOf,
  describe,
  type StandingCheckResult,
} from './award-standing-check.service';

export interface AwardStandingCheckSweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** Checks claimed per sweep — each a network call, so the bound on a sweep. */
  batchSize: number;
  /** How long a claim holds before another sweeper may take the check back. */
  leaseSeconds: number;
  /** A check supplier-service could not answer waits `min(max, base × 2^attempts)` seconds. */
  retryBackoffBaseSeconds: number;
  retryBackoffMaxSeconds: number;
}

export interface AwardStandingCheckOutcome {
  claimed: number;
  clear: number;
  conflict: number;
  /** supplier-service could not say, or the settling failed: counted, retried after its backoff. */
  retry: number;
  /** The claim was taken back before the write: nothing was changed. */
  lost: number;
}

/**
 * Makes the standing check after every award (ADR-067 § 3, residual), the same shape as
 * `TenderCloseSweeper`: each sweep claims a bounded batch of PENDING checks in one statement
 * (`FOR UPDATE SKIP LOCKED`, a lease and a fencing token), so any number of instances may run, then
 * asks supplier-service about each winner outside any transaction and settles each in its own short
 * one, in the award's own tenant, via `AwardStandingCheckService`.
 *
 * One check failing never stalls the batch and never starves the queue: its attempts are counted
 * and it is not claimed again until a bounded exponential backoff has passed. A check still pending
 * past `CONSTRUCTION_AWARD_CHECK_ALERT_AGE_SECONDS` is what the overdue gauge, and the warning alert
 * on it, are for. Nothing in `award` waits for this: a sweeper that is down delays only the check.
 */
export class AwardStandingCheckSweeper {
  private readonly logger = new Logger(AwardStandingCheckSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly checks: AwardStandingCheckRepository,
    private readonly service: AwardStandingCheckService,
    private readonly options: AwardStandingCheckSweeperOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried by the next
          // tick; the checks are still pending.
          this.logger.error(`Award standing-check sweep failed: ${closedCodeOf(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(tenderId?: string): Promise<AwardStandingCheckOutcome> {
    const claimed = await this.checks.claimDue(
      this.options.batchSize,
      this.options.leaseSeconds,
      ulid(),
      tenderId,
    );
    const outcome: AwardStandingCheckOutcome = {
      claimed: claimed.length,
      clear: 0,
      conflict: 0,
      retry: 0,
      lost: 0,
    };
    const COUNTED: Record<StandingCheckResult, keyof Omit<AwardStandingCheckOutcome, 'claimed'>> = {
      CLEAR: 'clear',
      CONFLICT: 'conflict',
      RETRY: 'retry',
      LOST: 'lost',
    };
    const backoff = {
      baseSeconds: this.options.retryBackoffBaseSeconds,
      maxSeconds: this.options.retryBackoffMaxSeconds,
    };

    for (const claim of claimed) {
      try {
        outcome[COUNTED[await this.service.process(claim, backoff)]] += 1;
      } catch (error) {
        // Settling failed (the database, or the event): the row is untouched, so it is retried.
        outcome.retry += 1;
        awardStandingChecksTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
        this.logger.error(
          `${describe(claim)} failed (${closedCodeOf(error)}); retried after a backoff`,
        );
        await this.service.recordFailure(claim, backoff);
      }
    }

    if (outcome.claimed > 0) {
      this.logger.log(
        `Award standing-check sweep: claimed ${outcome.claimed}, clear ${outcome.clear}, ` +
          `conflict ${outcome.conflict}, retry ${outcome.retry}, lost ${outcome.lost}`,
      );
    }
    return outcome;
  }
}
