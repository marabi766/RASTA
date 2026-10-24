import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import type { KeycloakProjector } from '../keycloak/keycloak.projector';
import {
  membershipLapseBacklog,
  membershipLapseFailuresTotal,
} from '../observability/keycloak-projection.metrics';
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
 * ## When Keycloak cannot be written (D-064)
 *
 * A lapse writes Keycloak before it commits (`expireLapsedMembership`), so a
 * lapse whose write fails is not acted on at all: unclaimed, no event, and
 * `validUntil` keeps the database from granting meanwhile. It is retried, and
 * it never holds back the lapses behind it: one that fails waits out a
 * backoff that doubles per failure — two intervals, then four, eight, up to
 * {@link MAX_BACKOFF_INTERVALS} — and a pass walks past it, page by page,
 * to the next. A pass makes at most `batchSize` attempts and reads at most
 * {@link MAX_PAGES_PER_PASS} pages. Nothing is ever
 * given up: a lapse is tried until it is acted on. The backlog — lapses past
 * `validUntil` and not acted on — is published after every pass
 * (`rasta_identity_membership_lapse_backlog`), and alerted on when it stays up.
 *
 * Each pass also re-projects users whose Keycloak write was left unconfirmed,
 * once that write can no longer land (`keycloak_reassert_at`): the sweep is
 * what makes "Keycloak never stays wider than the rows" hold when nothing
 * else would project them again.
 *
 * ## Shutdown
 *
 * `OutboxShutdown` stops it in Nest's destroy phase, beside both relays and the
 * purge, by their shared deadline (D-052): every lapse it handles writes an
 * outbox row, and a scanner that only cleared its timer went on with the pass
 * in flight while the relay drained and the pool closed.
 */
/** The longest a failing lapse waits between attempts, in scan intervals. */
export const MAX_BACKOFF_INTERVALS = 16;

/** How many pages of `batchSize` lapses one pass reads at most, looking past failing ones. */
export const MAX_PAGES_PER_PASS = 10;

/** How many failing lapses a replica remembers the backoff of; the oldest are forgotten first. */
const MAX_REMEMBERED_FAILURES = 10_000;

@Injectable()
export class MembershipExpiryScanner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MembershipExpiryScanner.name);
  private timer?: NodeJS.Timeout;
  /**
   * Lapses that failed, by membership id: how many times, and not to be tried
   * again before `retryAt`. Per replica, in memory — forgetting it (a restart)
   * only means trying sooner.
   */
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
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
    /** Re-projects users whose re-assertion mark has passed (D-064). */
    private readonly projector: Pick<KeycloakProjector, 'project'>,
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
      const handled = await this.expireLapses(now);
      await this.reassertDue();
      membershipLapseBacklog.set(await this.repository.countLapsedMemberships(now));
      return handled;
    } catch (error) {
      // Never takes the service down: access is already decided from the clock.
      this.logger.error(`Membership expiry scan failed: ${describe(error)}`);
      return 0;
    }
  }

  /**
   * Up to `batchSize` attempts, oldest lapse first, walking past the ones
   * waiting out a backoff to the ones behind them.
   */
  private async expireLapses(now: Date): Promise<number> {
    const { batchSize } = this.options;
    let attempts = 0;
    let handled = 0;
    let after: { validUntil: Date; id: string } | null = null;
    // Pages read, so a backlog of lapses all waiting out a backoff is not
    // walked end to end on every pass.
    let pages = 0;

    while (attempts < batchSize && pages < MAX_PAGES_PER_PASS && !this.stopped) {
      pages += 1;
      const page = await this.repository.findLapsedMemberships(now, batchSize, after);
      for (const membership of page) {
        // Stopping: a lapse not reached stays unhandled for the next pass.
        if (attempts >= batchSize || this.stopped) break;
        const failed = this.failures.get(membership.id);
        if (failed && failed.retryAt > now.getTime()) continue;
        attempts += 1;
        try {
          if (await this.identity.expireLapsedMembership(membership, now)) handled += 1;
          this.failures.delete(membership.id);
        } catch (error) {
          // Unclaimed, so a later pass retries it; the rest still need handling.
          this.backOff(membership.id, now);
          membershipLapseFailuresTotal.inc();
          this.logger.error(`Failed to expire membership ${membership.id}: ${describe(error)}`);
        }
      }
      const last = page.at(-1);
      if (page.length < batchSize || !last?.validUntil) break;
      after = { validUntil: last.validUntil, id: last.id };
    }

    if (handled > 0) this.logger.log(`Expired ${handled} of ${attempts} lapsed memberships tried`);
    return handled;
  }

  /**
   * One more failure: sit out the next pass, then twice as long each time, up
   * to the cap — so the next pass reaches the lapses behind this one.
   */
  private backOff(membershipId: string, now: Date): void {
    const count = (this.failures.get(membershipId)?.count ?? 0) + 1;
    const intervals = Math.min(2 ** count, MAX_BACKOFF_INTERVALS);
    this.failures.delete(membershipId);
    this.failures.set(membershipId, {
      count,
      retryAt: now.getTime() + intervals * this.options.intervalSeconds * 1000,
    });
    // Insertion order is age order: forget the oldest beyond the cap.
    while (this.failures.size > MAX_REMEMBERED_FAILURES) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  /**
   * Projects again, under the user lock, every user whose re-assertion mark
   * has passed (D-064); the projection clears the mark. One that fails keeps
   * it, or gets a later one, and is tried on a later pass.
   */
  private async reassertDue(): Promise<void> {
    const due = await this.repository.findUsersDueKeycloakReassert(this.options.batchSize);
    for (const userId of due) {
      if (this.stopped) break;
      try {
        await this.projector.project(userId, 'reassert');
      } catch (error) {
        this.logger.error(`Failed to re-assert user ${userId} in Keycloak: ${describe(error)}`);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
