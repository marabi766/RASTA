import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import type { KeycloakProjector } from '../keycloak/keycloak.projector';
import type { KeycloakWriteFences } from '../keycloak/keycloak-write-fence';
import { membershipLapseFailuresTotal } from '../observability/keycloak-projection.metrics';
import { withCancellation } from '../prisma/cancellation';
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
 * it never holds back the lapses behind it (#402 r1 F2):
 *
 * - **durable retry eligibility** — a lapse that fails waits out a backoff
 *   recorded in its own row (`lapse_retry_at`), doubling per failure — two
 *   intervals, then four, eight, up to {@link MAX_BACKOFF_INTERVALS} — and the
 *   query skips it until then, on every replica and across restarts;
 * - **a cursor that continues across passes** — a pass starts where the last
 *   one stopped (oldest lapse first) and wraps round to the start once, so
 *   lapses that became eligible behind it are reached too; at most `batchSize`
 *   attempts and {@link MAX_PAGES_PER_PASS} pages a pass.
 *
 * Nothing is ever given up: a lapse is tried until it is acted on. The backlog
 * — lapses past `validUntil` and not acted on — is sampled on its own timer,
 * not by a pass (`KeycloakFenceSampler`, `rasta_identity_membership_lapse_backlog`),
 * and alerted on when it stays up.
 *
 * ## Re-assertion (D-069)
 *
 * Each pass also projects again every user with a Keycloak write fence past
 * `takeover_at` (`keycloak_write_attempt`): a write whose outcome is unknown
 * and can no longer land. The projection writes the committed state under the
 * user lock and, once that lands, deletes the fences it took over. The same
 * fairness: a user whose re-assertion fails is deferred in their fence rows
 * (`next_reassert_at`, the same capped backoff), and a cursor by user id walks
 * on across passes. A user whose account Keycloak no longer has (404) is
 * terminal — their fences are marked `account_missing`, never retried, and
 * counted (`rasta_identity_keycloak_write_fences{state="account_missing"}`,
 * alerted on).
 *
 * ## Late senders (D-070 option D)
 *
 * A pass begins by writing the fresh fences of late writes this process could
 * not write when they were late (`KeycloakWriteFences.recoverOwed`) — a due
 * one is then re-asserted by that same pass — and a stop ends with the same
 * flush, before it returns.
 *
 * ## Shutdown
 *
 * `OutboxShutdown` stops it in Nest's destroy phase, beside both relays and the
 * purge, by their shared deadline (D-052). A stop cancels the pass in flight
 * (#402 r1 F4): the Keycloak call it is waiting on is aborted — its fence
 * stays, so stopping mid-write is safe (D-069) — and every later step of the
 * pass checks the stop before it starts. Below the
 * stages, the pass runs inside the database's cancellation boundary
 * (`prisma/cancellation.ts`, #402 r2 F2): every database operation it starts
 * anywhere — a read in the projector, a fence release, a transaction's setup
 * — checks the stop first. Nothing it would have done next reaches the
 * database once the stop has returned, but the rollback of the transaction it
 * was in.
 */
/** The longest a failing lapse or re-assertion waits between attempts, in scan intervals. */
export const MAX_BACKOFF_INTERVALS = 16;

/** How many pages of `batchSize` one pass reads at most, wrap-round included. */
export const MAX_PAGES_PER_PASS = 10;

type LapseKey = { validUntil: Date | null; id: string };
type LapsedMembership = Awaited<ReturnType<IdentityRepository['findLapsedMemberships']>>[number];

@Injectable()
export class MembershipExpiryScanner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MembershipExpiryScanner.name);
  private timer?: NodeJS.Timeout;
  /** Where the next pass resumes the lapses: the last one tried. Per replica; a restart starts over. */
  private lapseCursor: LapseKey | null = null;
  /** Where the next pass resumes the re-assertions: the last user tried. */
  private reassertCursor: string | null = null;
  /** The pass running, for the overlap guard and for a stop to wait on. */
  private inFlight?: Promise<number>;
  /** Set when the stop begins: no pass starts, and the one running starts no further step. */
  private stopped = false;
  /** Aborted when the stop begins: cancels the Keycloak call of the pass in flight. */
  private readonly cancel = new AbortController();
  /** The one stop; later calls join it. */
  private stopping?: Promise<void>;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly identity: IdentityService,
    /** From `MEMBERSHIP_EXPIRY_SCAN_*`; built by the module's factory. */
    private readonly options: MembershipExpiryScanOptions,
    /** Re-projects users with a write fence past takeover (D-069). */
    private readonly projector: Pick<KeycloakProjector, 'project'>,
    /** The write fences: who is due, their deferral, and late senders' owed fences (D-069, D-070 D). */
    private readonly fences: Pick<KeycloakWriteFences, 'dueUsers' | 'deferReassert' | 'recoverOwed'>,
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
   * Stops the timer at once, cancels the pass in flight — its Keycloak call
   * is aborted, and it starts no further step — and waits for it to unwind, at
   * most until `deadlineAt`, the shutdown's shared deadline. Past it the pass
   * is abandoned with a warning; it still starts nothing new, so nothing of it
   * reaches the database after this returns but the rollback of the
   * transaction it was in. Each lapse is claimed, written ahead and enqueued
   * in one transaction, so that rollback leaves it for the next pass, on any
   * replica; a Keycloak write cut off keeps its fence. Without a deadline it
   * waits. One stop per process.
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
    this.cancel.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const current = this.inFlight;
    if (current) {
      if (deadlineAt === undefined) {
        await current;
      } else if ((await withinDeadline(current, deadlineAt - Date.now())) === 'abandoned') {
        this.logger.warn(
          'Membership expiry pass still unwinding at the shutdown deadline; abandoned. It starts ' +
            'no further step; the lapse in flight rolls back and the next pass finds it again',
        );
      }
    }
    // Before returning, outside the scope the stop cancelled: the fresh fences
    // of late writes this process still owes — a late sender the stop refused,
    // and any write still unanswered past its deadline (D-070 D). Bounded by
    // what is left of the deadline; a fence not written by then is not, and
    // the residual is stated in ADR-060.
    const flush = this.fences.recoverOwed();
    const owed =
      deadlineAt === undefined
        ? await flush
        : (await withinDeadline(flush, Math.max(0, deadlineAt - Date.now()))) === 'finished'
          ? await flush
          : -1;
    if (owed !== 0) {
      this.logger.error(
        `Stopping with ${owed < 0 ? 'unknown' : owed} late Keycloak write fences unwritten ` +
          '(D-070 D); the old fences, if not yet taken over, still stand',
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
    // Every database operation of the pass — wherever in the projector, the
    // service or the fences it starts — checks the stop first (#402 r2 F2).
    const pass = withCancellation(this.cancel.signal, () => this.pass(now)).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = pass;
    return pass;
  }

  private async pass(now: Date): Promise<number> {
    try {
      // First, the retry of late senders' fresh fences this process could
      // not write (D-070 D): a due one is then re-asserted by this very pass.
      await this.fences.recoverOwed();
      if (this.stopped) return 0;
      const handled = await this.expireLapses(now);
      // Every stage checks the stop before it starts (#402 r1 F4).
      if (this.stopped) return handled;
      await this.reassertDue();
      // No gauge is sampled here any more: a pass is serial and may be long,
      // skipped or failed, so the fence and lapse gauges have a sampler of
      // their own (`KeycloakFenceSampler`, #402 r3 R3-2).
      return handled;
    } catch (error) {
      // Never takes the service down: access is already decided from the clock.
      if (!this.stopped) this.logger.error(`Membership expiry scan failed: ${describe(error)}`);
      return 0;
    }
  }

  /**
   * Up to `batchSize` attempts, from where the last pass stopped, wrapping
   * round to the oldest once; lapses waiting out a retry are not read at all.
   */
  private async expireLapses(now: Date): Promise<number> {
    let attempts = 0;
    let handled = 0;
    this.lapseCursor = await this.roundRobin<LapsedMembership, LapseKey>(
      this.lapseCursor,
      (after, until) =>
        this.repository.findLapsedMemberships(now, this.options.batchSize, after, until),
      (membership) => ({ validUntil: membership.validUntil, id: membership.id }),
      async (membership) => {
        attempts += 1;
        try {
          const acted = await this.identity.expireLapsedMembership(membership, now, {
            signal: this.cancel.signal,
          });
          if (acted) handled += 1;
        } catch (error) {
          if (this.stopped) return;
          // Unclaimed, so a later pass retries it — once its backoff, kept in
          // its row, has passed; the rest still need handling.
          membershipLapseFailuresTotal.inc();
          this.logger.error(`Failed to expire membership ${membership.id}: ${describe(error)}`);
          await this.repository
            .deferLapse(membership.id, this.options.intervalSeconds, MAX_BACKOFF_INTERVALS)
            .catch((deferError: unknown) =>
              this.logger.error(`Could not defer lapse ${membership.id}: ${describe(deferError)}`),
            );
        }
      },
    );
    if (handled > 0) this.logger.log(`Expired ${handled} of ${attempts} lapsed memberships tried`);
    return handled;
  }

  /**
   * Projects again, under the user lock, every user with a write fence past
   * takeover (D-069), from where the last pass stopped, wrapping round once;
   * the projection deletes the fences it took over. One that fails is
   * deferred in its fence rows; a missing account is made terminal by the
   * projection itself (`account_missing`).
   */
  private async reassertDue(): Promise<void> {
    this.reassertCursor = await this.roundRobin<string, string>(
      this.reassertCursor,
      (after, until) => this.fences.dueUsers(after, this.options.batchSize, until),
      (userId) => userId,
      async (userId) => {
        try {
          await this.projector.project(userId, 'reassert', { signal: this.cancel.signal });
        } catch (error) {
          if (this.stopped) return;
          this.logger.error(`Failed to re-assert user ${userId} in Keycloak: ${describe(error)}`);
          await this.fences
            .deferReassert(userId, this.options.intervalSeconds, MAX_BACKOFF_INTERVALS)
            .catch((deferError: unknown) =>
              this.logger.error(
                `Could not defer re-assertion of ${userId}: ${describe(deferError)}`,
              ),
            );
        }
      },
    );
  }

  /**
   * Fair progress across passes (#402 r1 F2): visits at most `batchSize`
   * items, in the store's order, starting after `start` — where the last pass
   * stopped — to the end, then once round from the oldest up to `start`
   * (`until`, bounded in the query). Returns where the next pass starts: the
   * last item visited, or null once a whole round is done. Items not eligible
   * (waiting out a retry) are never read, so no failing prefix can take a
   * pass's budget; the cursor makes every eligible item visited within
   * ⌈eligible / batchSize⌉ passes.
   */
  private async roundRobin<T, K>(
    start: K | null,
    read: (after: K | null, until: K | null) => Promise<T[]>,
    keyOf: (item: T) => K,
    visit: (item: T) => Promise<void>,
  ): Promise<K | null> {
    const { batchSize } = this.options;
    let after = start;
    let wrapped = start === null;
    let visited = 0;
    let pages = 0;
    while (visited < batchSize && pages < MAX_PAGES_PER_PASS && !this.stopped) {
      pages += 1;
      const page = await read(after, wrapped ? start : null);
      for (const item of page) {
        if (visited >= batchSize || this.stopped) return after;
        visited += 1;
        after = keyOf(item);
        await visit(item);
      }
      if (visited >= batchSize || this.stopped) return after;
      if (page.length < batchSize) {
        // The end. Round once from the oldest, unless this pass began there.
        if (wrapped) return null;
        wrapped = true;
        after = null;
      }
    }
    return after;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
