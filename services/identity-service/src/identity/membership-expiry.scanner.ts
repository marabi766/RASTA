import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';

export interface MembershipExpiryScanOptions {
  enabled: boolean;
  intervalSeconds: number;
  batchSize: number;
}

/**
 * Notices that a membership's `validUntil` has passed (ADR-060 § 5).
 *
 * A membership stops granting anything at `validUntil` without any help: the
 * projection, the organization switch and every other decision read the
 * validity window against the clock (`membership-window.ts`). What nothing
 * notices is the moment itself. No request arrives when a date passes, so the
 * user's Keycloak attributes — and therefore their tokens — would keep naming
 * the organization until some unrelated membership change re-projected them.
 * That is the gap this closes.
 *
 * ## Latency
 *
 * A lapse is acted on within one scan interval
 * (`MEMBERSHIP_EXPIRY_SCAN_INTERVAL_SECONDS`, default 60) of `validUntil`, plus
 * the Keycloak write. A token minted before that write still carries the
 * organization until it expires — the ≤ 905 s ADR-060 § 7 accepts for every
 * membership change. So the bound from `validUntil` to the last token that
 * names the organization is **interval + 905 s**; to the last request
 * identity-service itself accepts for it, **zero**.
 *
 * ## Why it is safe on every replica, and across restarts
 *
 * The same shape as maintenance-service's `DueScanner`: no leader, no lock.
 * Each lapse is claimed with a guarded update (`lapse_handled_at IS NULL`), so
 * replicas scanning together act once, and a replica that was down when a
 * membership expired finds it on its first pass — the query asks what is
 * unhandled, not what expired since the last tick.
 *
 * It does not revoke. An expired membership stays what it was, `ACTIVE` with
 * a `validUntil` in the past; whether expiry should also end the row is not
 * something any document decides.
 *
 * ## Shutdown
 *
 * `OutboxShutdown` stops it in Nest's destroy phase, beside both relays and the
 * purge, by their shared deadline (D-052): every lapse it handles writes an
 * outbox row, and a scanner that only cleared its timer went on with the pass
 * in flight while the relay drained and the pool closed.
 */
@Injectable()
export class MembershipExpiryScanner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MembershipExpiryScanner.name);
  private timer?: NodeJS.Timeout;
  /** The pass running, for the overlap guard and for a stop to wait on. */
  private inFlight?: Promise<number>;
  /** Set when the stop begins: no pass starts, and the one running starts no further lapse. */
  private stopped = false;
  /** The one stop; later calls join it. */
  private stopping?: Promise<void>;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly identity: IdentityService,
    /** From `MEMBERSHIP_EXPIRY_SCAN_*`; built by the module's factory. */
    private readonly options: MembershipExpiryScanOptions,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) {
      this.logger.warn(
        'Membership expiry scanning is disabled; an expired membership grants nothing, ' +
          'but tokens keep naming it until the user is next re-projected',
      );
      return;
    }

    this.timer = setInterval(() => void this.scan(), this.options.intervalSeconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Scanning for lapsed memberships every ${this.options.intervalSeconds}s`);
  }

  /**
   * Stops the timer at once, lets the pass in flight start no further lapse,
   * and waits for the one being handled — at most until `deadlineAt`, the
   * shutdown's shared deadline. Past it the pass is abandoned with a warning:
   * each lapse is claimed, moved off and enqueued in one transaction, so an
   * exit rolls back the one in flight and the next pass, on any replica, finds
   * it again; one already committed has its `MEMBERSHIP_EXPIRED` row, which the
   * Keycloak projection consumer re-projects from. Without a deadline it waits.
   * One stop per process.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopping ??= this.halt(options.deadlineAt);
    return this.stopping;
  }

  /** Joins the stop `OutboxShutdown` began; returns at once. */
  onApplicationShutdown(): Promise<void> {
    return this.stop();
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
        'Membership expiry pass still running at the shutdown deadline; abandoned. The lapse ' +
          'in flight rolls back and the next pass finds it again',
      );
    }
  }

  /**
   * One pass. Public so a test drives it with a controlled clock and an
   * operator can force one; the overlap guard keeps a slow pass from doubling
   * the work of the next. Once stopping, none starts.
   */
  scan(now: Date = new Date()): Promise<number> {
    if (this.inFlight || this.stopped) return Promise.resolve(0);
    const pass = this.pass(now).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = pass;
    return pass;
  }

  private async pass(now: Date): Promise<number> {
    try {
      const lapsed = await this.repository.findLapsedMemberships(now, this.options.batchSize);

      let handled = 0;
      for (const membership of lapsed) {
        // Stopping: a lapse not reached stays unhandled for the next pass.
        if (this.stopped) break;
        try {
          if (await this.identity.expireLapsedMembership(membership, now)) handled += 1;
        } catch (error) {
          // Unclaimed, so the next pass retries it; the rest still need handling.
          this.logger.error(`Failed to expire membership ${membership.id}: ${describe(error)}`);
        }
      }

      if (handled > 0) this.logger.log(`Expired ${handled} of ${lapsed.length} lapsed memberships`);
      return handled;
    } catch (error) {
      // Never takes the service down: access is already decided from the clock.
      this.logger.error(`Membership expiry scan failed: ${describe(error)}`);
      return 0;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
