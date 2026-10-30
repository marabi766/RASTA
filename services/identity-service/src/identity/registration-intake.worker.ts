import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { settleWithin, withCancellation } from '../prisma/cancellation';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';

export interface RegistrationIntakeOptions {
  intervalSeconds: number;
  batchSize: number;
}

/** The longest a failing intake row waits between attempts, in intervals. */
export const MAX_INTAKE_BACKOFF_INTERVALS = 16;

/**
 * Turns received public registrations into requests, after their applicants
 * have been answered (task 130, PR #483 r1 R5).
 *
 * `POST /v1/registration-requests` writes one `registration_intake` row and
 * answers — the same work for every applicant, so the time to the answer says
 * nothing about whether the username or the email is held. Whether it is, is
 * decided here, privately: each due row is recorded as a PENDING user and a
 * request, or discarded as a duplicate (`IdentityService.processRegistrationIntake`).
 *
 * ## Latency
 *
 * A submission reaches the review queue within one interval
 * (`REGISTRATION_INTAKE_INTERVAL_SECONDS`, default 5) — review is a person's
 * job, measured in hours. There is no switch to turn it off: without it no
 * registration would ever reach a reviewer.
 *
 * ## Every replica, every restart
 *
 * No leader. Each row is taken `FOR UPDATE SKIP LOCKED` and deleted in the
 * transaction that handles it, so replicas draining together handle it once,
 * and a row received while every worker was down is handled on the first
 * pass. A row whose handling fails is deferred in its own row
 * (`next_attempt_at`, doubling up to {@link MAX_INTAKE_BACKOFF_INTERVALS}),
 * and the read skips it until then, so it never holds back the rows behind it.
 *
 * ## Shutdown
 *
 * Stopped by `OutboxShutdown` with the relays and the expiry scanner, by
 * their shared deadline (D-052). A stop starts no further row, cancels the
 * pass in flight below the database's cancellation boundary
 * (`prisma/cancellation.ts`) and waits — by the deadline — for its
 * transactions to settle. A row cut off rolls back and stays for the next
 * pass, on any replica.
 */
@Injectable()
export class RegistrationIntakeWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RegistrationIntakeWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private stopped = false;
  private readonly cancel = new AbortController();
  private readonly transactions = new Set<Promise<unknown>>();
  private stopping?: Promise<void>;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly identity: IdentityService,
    /** From `REGISTRATION_INTAKE_*`; built by the module's factory. */
    private readonly options: RegistrationIntakeOptions,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), this.options.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  /**
   * Stops the timer, cancels the pass in flight and waits for it to unwind,
   * at most until `deadlineAt`; then for its transactions still unsettled. One
   * stop per process; later calls join it.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopping ??= this.halt(options.deadlineAt);
    return this.stopping;
  }

  /** Joins the stop `OutboxShutdown` began. */
  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    this.stopped = true;
    this.cancel.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const current = this.inFlight;
    if (current) {
      if (deadlineAt === undefined) {
        await current;
      } else if ((await withinDeadline(current, deadlineAt - Date.now())) === 'abandoned') {
        this.logger.warn(
          'Registration intake pass still unwinding at the shutdown deadline; abandoned. The row ' +
            'in flight rolls back and the next pass finds it again',
        );
      }
    }
    const unsettled = await settleWithin(this.transactions, deadlineAt);
    if (unsettled > 0) {
      this.logger.error(
        `Registration intake stopped at the shutdown deadline with ${unsettled} transactions ` +
          'unsettled: they may still commit',
      );
    }
  }

  /**
   * One pass: up to `batchSize` due rows. Public so a test drives it and an
   * operator can force one; the overlap guard keeps passes from doubling up.
   * Resolves to how many rows it recorded or discarded.
   */
  drain(): Promise<number> {
    if (this.inFlight || this.stopped) return Promise.resolve(0);
    const pass = withCancellation(this.cancel.signal, () => this.pass(), {
      transactions: this.transactions,
    }).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = pass;
    return pass;
  }

  private async pass(): Promise<number> {
    let handled = 0;
    try {
      const due = await this.repository.findDueRegistrationIntakes(this.options.batchSize);
      for (const intakeId of due) {
        if (this.stopped) break;
        try {
          const result = await this.identity.processRegistrationIntake(intakeId);
          if (result.outcome !== 'GONE') handled += 1;
        } catch (error) {
          if (this.stopped) break;
          this.logger.error(`Failed to handle registration intake ${intakeId}: ${describe(error)}`);
          await this.repository
            .deferRegistrationIntake(
              intakeId,
              this.options.intervalSeconds,
              MAX_INTAKE_BACKOFF_INTERVALS,
            )
            .catch((deferError: unknown) =>
              this.logger.error(`Could not defer intake ${intakeId}: ${describe(deferError)}`),
            );
        }
      }
    } catch (error) {
      // Never takes the service down: the rows stay for the next pass.
      if (!this.stopped) this.logger.error(`Registration intake pass failed: ${describe(error)}`);
    }
    return handled;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
