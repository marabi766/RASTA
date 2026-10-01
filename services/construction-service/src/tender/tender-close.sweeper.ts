import { Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SERVICE_NAME } from '../config/env';
import { tenderCloseTotal } from '../observability/metrics';
import { TenderCloseRepository } from './tender-close.repository';
import { TenderCloseService, type CloseResult } from './tender-close.service';

export interface TenderCloseSweeperOptions {
  /** How often a sweep runs. */
  intervalMs: number;
  /** Tenders claimed per sweep — with one short transaction each, the bound on a sweep. */
  batchSize: number;
  /** How long a claim holds before another sweeper may take the tender back. */
  leaseSeconds: number;
}

export interface TenderCloseOutcome {
  claimed: number;
  closed: number;
  /** Already closed or cancelled by someone else. */
  noop: number;
  /** The deadline was moved after the claim: given back, still PUBLISHED. */
  notDue: number;
  /** The claim was taken back before the write: nothing was changed. */
  lost: number;
  /** Failed; the claim stays until its lease runs out, then the tender is taken again. */
  failed: number;
}

const COUNTED: Record<CloseResult, keyof Omit<TenderCloseOutcome, 'claimed' | 'failed'>> = {
  CLOSED: 'closed',
  NOOP: 'noop',
  NOT_DUE: 'notDue',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

const METRIC_RESULT: Record<CloseResult, string> = {
  CLOSED: 'closed',
  NOOP: 'noop',
  NOT_DUE: 'not_due',
  NOT_OWNER: 'lost',
  NOT_FOUND: 'noop',
};

/**
 * Closes the tenders whose bidding window has ended (ADR-065 § 3), the same shape
 * as `PolicyReconciliationSweeper`: each sweep claims a bounded batch of PUBLISHED
 * tenders past `bid_closing_at` in one statement (`FOR UPDATE SKIP LOCKED`, a lease
 * and a fencing token), so any number of instances may run, and closes each in its
 * own short transaction, in the tender's own tenant, via `TenderCloseService`.
 *
 * Bounded by configuration: the batch size and the interval, with a close costing one
 * transaction and no network call. One tender failing never stalls the batch; its
 * claim simply stays until the lease runs out and it is taken again. Nothing here is
 * required for a bid to be refused after the deadline — that is the database's clock
 * (see `TenderCloseService`) — so a sweeper that is down delays only the state.
 */
export class TenderCloseSweeper {
  private readonly logger = new Logger(TenderCloseSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;

  constructor(
    private readonly closes: TenderCloseRepository,
    private readonly service: TenderCloseService,
    private readonly options: TenderCloseSweeperOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried by the
          // next tick; the tenders are still overdue.
          this.logger.error(`Tender close sweep failed: ${codeOf(error)}`);
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
  async runOnce(): Promise<TenderCloseOutcome> {
    const fence = ulid();
    const claimed = await this.closes.claimDue(
      this.options.batchSize,
      this.options.leaseSeconds,
      fence,
    );
    const outcome: TenderCloseOutcome = {
      claimed: claimed.length,
      closed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    };

    for (const tender of claimed) {
      try {
        const result = await this.service.close({
          organizationId: tender.organizationId,
          tenderId: tender.id,
          fence: tender.fence,
        });
        outcome[COUNTED[result]] += 1;
        tenderCloseTotal.inc({ service: SERVICE_NAME, result: METRIC_RESULT[result] });
      } catch (error) {
        outcome.failed += 1;
        tenderCloseTotal.inc({ service: SERVICE_NAME, result: 'failed' });
        this.logger.warn(
          `Closing tender ${tender.id} failed: ${codeOf(error)}; retried after its lease`,
        );
      }
    }

    if (outcome.claimed > 0) {
      this.logger.log(
        `Tender close sweep: claimed ${outcome.claimed}, closed ${outcome.closed}, ` +
          `noop ${outcome.noop}, not due ${outcome.notDue}, lost ${outcome.lost}, failed ${outcome.failed}`,
      );
    }
    return outcome;
  }
}

/** The closed code recorded for a failure: a platform error code, or `INTERNAL`. */
function codeOf(error: unknown): string {
  return error instanceof RastaError ? error.code : 'INTERNAL';
}
