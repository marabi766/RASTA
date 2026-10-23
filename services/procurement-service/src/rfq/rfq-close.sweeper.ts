import { Logger } from '@nestjs/common';
import { RastaError, withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { rfqCloseSweepTotal } from '../observability/metrics';
import { RfqRepository } from './rfq.repository';
import { RfqCloseService, type RfqCloseResult } from './rfq-close.service';

export interface RfqCloseSweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** RFQs claimed per sweep. */
  batchSize: number;
  /** How long a claim holds before another sweeper may take the RFQ. */
  leaseSeconds: number;
  /** A failed RFQ waits `min(max, base × 2^attempts)` seconds before it is claimed again. */
  retryBackoffBaseSeconds: number;
  retryBackoffMaxSeconds: number;
}

export interface RfqCloseSweepOutcome {
  claimed: number;
  /** RFQs this sweep closed. */
  closed: number;
  /** No longer PUBLISHED: closed by a person, or cancelled. */
  noop: number;
  /** Not past the deadline after the lock. */
  notDue: number;
  /** The claim was taken back before the write: nothing was changed. */
  lost: number;
  /** Failed; counted, and the RFQ is taken again only after its backoff. */
  failed: number;
}

const COUNTED: Record<RfqCloseResult, keyof Omit<RfqCloseSweepOutcome, 'claimed' | 'failed'>> = {
  CLOSED: 'closed',
  NOOP: 'noop',
  NOT_DUE: 'notDue',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

const METRIC_RESULT: Record<RfqCloseResult, string> = {
  CLOSED: 'closed',
  NOOP: 'noop',
  NOT_DUE: 'not_due',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

/**
 * Closes the RFQs whose quotation deadline has passed (ADR-070 § 3, plan PR 6), so an RFQ is CLOSED
 * on time whether or not a person of the buyer closes it — the shape of the aggregation window
 * sweeper (plan PR 2) and of construction's `TenderCloseSweeper` (ADR-065 § 3). Each sweep claims a
 * bounded batch in one statement (`FOR UPDATE SKIP LOCKED`, a lease and a fencing token), so any
 * number of instances may run, and closes each in a transaction of its own, in the RFQ's own
 * tenant, via `RfqCloseService`.
 *
 * Nothing here is required for a quotation to be refused at the deadline — that is the database
 * clock, read after the RFQ's lock by every quotation command (plan PR 8) — so a sweeper that is
 * down delays only the state. One RFQ failing never stalls the batch: it is counted and not claimed
 * again before a bounded exponential backoff.
 */
export class RfqCloseSweeper {
  private readonly logger = new Logger(RfqCloseSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly rfqs: RfqRepository,
    private readonly service: RfqCloseService,
    private readonly options: RfqCloseSweeperOptions,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          this.logger.error(`RFQ close sweep failed: ${codeOf(error)}`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops the timer at once and waits for the sweep in flight — at most until `deadlineAt`, the
   * shutdown's shared deadline (`OutboxShutdown`, D-052), so no close writes an outbox row after the
   * relay drained. Past it the sweep is abandoned: each close and its event commit in one
   * transaction, and the lease lets the next sweep take the RFQ again. One stop per process.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopping ??= this.halt(options.deadlineAt);
    return this.stopping;
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const current = this.inFlight;
    if (!current) return;
    if (deadlineAt === undefined) {
      await current;
      return;
    }
    if ((await withinDeadline(current, deadlineAt - Date.now())) === 'abandoned') {
      this.logger.warn(
        'RFQ close sweep still running at the shutdown deadline; abandoned. The close in flight ' +
          'rolls back and its lease lets the next sweep take the RFQ again',
      );
    }
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<RfqCloseSweepOutcome> {
    const fence = ulid();
    const claimed = await this.rfqs.claimDue(
      this.options.batchSize,
      this.options.leaseSeconds,
      fence,
    );
    const outcome: RfqCloseSweepOutcome = {
      claimed: claimed.length,
      closed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    };

    for (const rfq of claimed) {
      // Stopping: the RFQ keeps its claim until the lease runs out, then any sweep takes it.
      if (this.stopped) break;
      const target = { organizationId: rfq.organizationId, rfqId: rfq.id, fence: rfq.fence };
      try {
        const result = await this.service.close(target);
        outcome[COUNTED[result]] += 1;
        rfqCloseSweepTotal.inc({ service: SERVICE_NAME, result: METRIC_RESULT[result] });
      } catch (error) {
        outcome.failed += 1;
        rfqCloseSweepTotal.inc({ service: SERVICE_NAME, result: 'failed' });
        this.logger.warn(`Closing RFQ ${rfq.id} failed: ${codeOf(error)}; retried after a backoff`);
        try {
          await this.service.recordFailure(target, {
            baseSeconds: this.options.retryBackoffBaseSeconds,
            maxSeconds: this.options.retryBackoffMaxSeconds,
          });
        } catch (recordError) {
          // The lease running out is the fallback retry.
          this.logger.warn(
            `Recording the failed close of RFQ ${rfq.id} failed: ${codeOf(recordError)}`,
          );
        }
      }
    }

    if (outcome.claimed > 0) {
      this.logger.log(
        `RFQ close sweep: claimed ${outcome.claimed}, closed ${outcome.closed}, noop ${outcome.noop}, ` +
          `not due ${outcome.notDue}, lost ${outcome.lost}, failed ${outcome.failed}`,
      );
    }
    return outcome;
  }
}

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. */
function codeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}
