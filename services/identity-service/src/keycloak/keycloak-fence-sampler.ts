import { performance } from 'node:perf_hooks';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { withinDeadline } from '@rasta/nest-common';
import type { IdentityRepository } from '../identity/identity.repository';
import {
  keycloakFenceSampleDuration,
  keycloakFenceSamplesTotal,
  membershipLapseBacklog,
  readFenceSamplesFrom,
  type FenceSampleView,
} from '../observability/keycloak-projection.metrics';
import { withCancellation } from '../prisma/cancellation';
import type { PrismaService } from '../prisma/prisma.service';
import { fenceCounts, type FenceCounts } from './keycloak-write-fence';

/**
 * The independent sampler of the Keycloak write fences (#402 r3 R3-2,
 * ADR-060 D-069 addendum § 8).
 *
 * The fence gauges — above all `overdue`, the D-070 deployment assumption's
 * signal — used to be sampled at the end of a sweep pass, after its serial
 * lapses and re-assertions: a pass that ran long, failed early, or a tick its
 * overlap guard skipped took no sample, and a fence's whole overdue window
 * could pass unseen. So they have a sampler of their own:
 *
 * - **its own timer** ({@link FENCE_SAMPLE_INTERVAL_MS}), started at boot, a
 *   first sample at once; and **its own guard**: a tick that finds its own
 *   previous sample still running counts `busy` and returns — the sweep's
 *   guard, its lapses and its locks never come into it;
 * - **its own connection**: a pool of one, apart from the business pool
 *   (which transactions queued on a user lock can exhaust) and from the fence
 *   pool (two connections, which every Keycloak write needs) — it can starve
 *   neither, and neither can starve it;
 * - **bounded**: one short transaction — the connection wait (`maxWait`), a
 *   `lock_timeout`, a `statement_timeout` and the transaction's own timeout,
 *   each {@link FENCE_SAMPLE_BUDGET_MS} — and, above all of them, a deadline
 *   of that same budget on this side: a sample that has not answered by then
 *   is a failure, however its transaction ends. Its next tick waits for that
 *   transaction to end (`busy`), so failures never pile up on the connection;
 * - **one full aggregate** (`fenceCounts`: `COUNT(*) FILTER`), never a page.
 *
 * What the gauges read is computed **at scrape** (`readFenceSamplesFrom`):
 * `overdue` and `expired` are the largest of every sample in the last
 * {@link FENCE_SAMPLE_RETENTION_MS} — two scrape intervals — so a sample that
 * fell inside a window reaches at least one scrape; and the age gauge is the
 * time since the latest successful sample **started**, or the largest gap
 * between two successful samples' starts within that same retention, if
 * larger. It keeps growing while sampling hangs or fails, and a gap that
 * closed between two scrapes is still seen. Before the first success, it is
 * the time since the sampler started; no fence series is exported until then
 * — silence is not zero.
 *
 * The lapse backlog (`rasta_identity_membership_lapse_backlog`) leaves the
 * sweep's pass too, on a slower timer of its own ({@link LAPSE_SAMPLE_INTERVAL_MS}):
 * it counts memberships on the business pool, unindexed for this predicate,
 * and is alerted on only after 20 minutes.
 *
 * Per replica: every replica samples the same table and exports the same
 * counts; the rules take `max` of the counts and `min` of the age — overdue is
 * seen while any one replica samples, and the stale alert fires when none
 * does.
 */

/** How often the fences are sampled. */
export const FENCE_SAMPLE_INTERVAL_MS = 2_000;

/**
 * The whole bound of one sample: its wait for the connection, for a lock, its
 * statement and its transaction; and the deadline on this side over all of
 * them. A sample past it is a failure.
 */
export const FENCE_SAMPLE_BUDGET_MS = 1_000;

/**
 * How long a sample's `overdue` and `expired`, and a gap between two samples,
 * stay in the gauges: two scrape intervals (15 s, `prometheus.yml`), so a
 * value is seen even when one scrape is lost.
 */
export const FENCE_SAMPLE_RETENTION_MS = 30_000;

/**
 * Above this, `RastaIdentityKeycloakFenceSamplerStale` fires
 * (`rasta-identity-alerts.yml`, which states it as a literal). Chosen so that
 * a gap it does not report, plus one sample's budget, is shorter than the
 * shortest overdue window any accepted configuration has
 * (`KEYCLOAK_WRITE_SETTLE_SECONDS` ≥ 15, so half of it ≥ 7.5 s):
 * 6 + 1 = 7 s < 7.5 s. ADR-060 D-069 addendum § 8 has the proof.
 */
export const FENCE_SAMPLE_STALE_SECONDS = 6;

/** How often the lapse backlog is counted. */
export const LAPSE_SAMPLE_INTERVAL_MS = 30_000;

/** The bound of one lapse count, on the business pool: connection wait, statement, transaction. */
export const LAPSE_SAMPLE_BUDGET_MS = 5_000;

/** Where the sampler's numbers come from: each call one bounded query. */
export interface FenceSampleSource {
  /** Every fence, counted by state as of one database instant. */
  fences(budgetMs: number): Promise<FenceCounts>;
  /** Lapsed memberships not acted on, as of the database's clock. */
  lapseBacklog(budgetMs: number): Promise<number>;
}

/**
 * The production source: the fences on the sampler's own one-connection pool,
 * the lapse backlog on the business pool, each in one short transaction whose
 * connection wait, lock waits, statements and duration are all bounded.
 */
export function pooledFenceSampleSource(
  own: PrismaService,
  business: Pick<IdentityRepository, 'transaction' | 'countLapsedMemberships' | 'databaseNow'>,
): FenceSampleSource {
  return {
    fences: (budgetMs) =>
      own.transaction(
        async (tx) => {
          // Waits on a lock — the down migration's ACCESS EXCLUSIVE — end too.
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${wholeMs(budgetMs)}`);
          return fenceCounts(tx);
        },
        { maxWait: budgetMs, timeout: budgetMs, statementTimeoutMs: wholeMs(budgetMs) },
      ),
    lapseBacklog: (budgetMs) =>
      business.transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${wholeMs(budgetMs)}`);
          return business.countLapsedMemberships(await business.databaseNow(tx), tx);
        },
        { maxWait: budgetMs, timeout: budgetMs, statementTimeoutMs: wholeMs(budgetMs) },
      ),
  };
}

export interface KeycloakFenceSamplerOptions {
  intervalMs?: number;
  budgetMs?: number;
  retentionMs?: number;
  lapseIntervalMs?: number;
  lapseBudgetMs?: number;
  /** A monotonic clock in milliseconds; `performance.now` unless a test drives its own. */
  clock?: () => number;
  /** Closed by the sampler's stop: its own pool, which nothing else uses. */
  ownPool?: Pick<PrismaService, 'onModuleDestroy'>;
}

interface Retained {
  /** When the sample started, on the monotonic clock. */
  at: number;
  overdue: number;
  expired: number;
  /** From the previous successful sample's start (or the sampler's), to this one's. */
  gap: number;
}

export class KeycloakFenceSampler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeycloakFenceSampler.name);
  private readonly intervalMs: number;
  private readonly budgetMs: number;
  private readonly retentionMs: number;
  private readonly lapseIntervalMs: number;
  private readonly lapseBudgetMs: number;
  private readonly clock: () => number;
  private timer?: NodeJS.Timeout;
  private lapseTimer?: NodeJS.Timeout;
  /** This sampler's own sample in flight: its own guard, nobody else's. */
  private inFlight?: Promise<void>;
  private lapseInFlight?: Promise<void>;
  /** Aborted by the stop: nothing it starts afterwards reaches the database. */
  private readonly cancel = new AbortController();
  private startedAt = 0;
  private lastSuccessAt: number | null = null;
  private latest: FenceCounts | null = null;
  private readonly retained: Retained[] = [];
  /** Whether the last sample failed, so a run of failures logs once. */
  private failing = false;
  private readonly reader = (): FenceSampleView => this.view();

  constructor(
    private readonly source: FenceSampleSource,
    private readonly options: KeycloakFenceSamplerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? FENCE_SAMPLE_INTERVAL_MS;
    this.budgetMs = options.budgetMs ?? FENCE_SAMPLE_BUDGET_MS;
    this.retentionMs = options.retentionMs ?? FENCE_SAMPLE_RETENTION_MS;
    this.lapseIntervalMs = options.lapseIntervalMs ?? LAPSE_SAMPLE_INTERVAL_MS;
    this.lapseBudgetMs = options.lapseBudgetMs ?? LAPSE_SAMPLE_BUDGET_MS;
    this.clock = options.clock ?? (() => performance.now());
  }

  onModuleInit(): void {
    this.start();
  }

  /** Feeds the gauges from now on; a first sample at once, then one every interval. */
  start(): void {
    if (this.timer) return;
    this.startedAt = this.clock();
    readFenceSamplesFrom(this.reader);
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.sampleLapses();
    this.lapseTimer = setInterval(() => this.sampleLapses(), this.lapseIntervalMs);
    this.lapseTimer.unref?.();
  }

  /**
   * Its own bounded stop: the timers end, nothing more reaches the database,
   * the sample in flight is waited for at most one budget, the gauges are
   * detached and its own pool is closed.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.lapseTimer) clearInterval(this.lapseTimer);
    this.timer = undefined;
    this.lapseTimer = undefined;
    this.cancel.abort();
    const pending = Promise.all([this.inFlight, this.lapseInFlight]);
    await withinDeadline(pending, Math.max(this.budgetMs, this.lapseBudgetMs));
    // Detached only if the gauges still read this sampler.
    const previous = readFenceSamplesFrom(null);
    if (previous !== this.reader) readFenceSamplesFrom(previous);
    await this.options.ownPool?.onModuleDestroy().catch(() => undefined);
  }

  /** One tick of its own timer. Public so a test can drive it. */
  tick(): void {
    if (this.cancel.signal.aborted) return;
    if (this.inFlight) {
      keycloakFenceSamplesTotal.inc({ outcome: 'busy' });
      return;
    }
    const run = this.sample().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
  }

  /** The gauges' view, as of now (`keycloak-projection.metrics.ts`). */
  view(): FenceSampleView {
    const now = this.clock();
    this.prune(now);
    let overdue = this.latest?.overdue ?? 0;
    let expired = this.latest?.expired ?? 0;
    let gap = 0;
    for (const sample of this.retained) {
      overdue = Math.max(overdue, sample.overdue);
      expired = Math.max(expired, sample.expired);
      gap = Math.max(gap, sample.gap);
    }
    const age = now - (this.lastSuccessAt ?? this.startedAt);
    return {
      latest: this.latest
        ? {
            live: this.latest.live,
            due: this.latest.due,
            accountMissing: this.latest.accountMissing,
            overdue: this.latest.overdue,
            expired: this.latest.expired,
          }
        : null,
      retained: { overdue, expired },
      ageSeconds: Math.max(age, gap) / 1000,
    };
  }

  private async sample(): Promise<void> {
    const startedAt = this.clock();
    let counts: FenceCounts | undefined;
    const query = withCancellation(this.cancel.signal, () => this.source.fences(this.budgetMs));
    const settled = query.then(
      (value) => {
        counts = value;
      },
      (error: unknown) => {
        this.fail(error);
      },
    );
    const answered = (await withinDeadline(settled, this.budgetMs)) === 'finished';
    const took = (this.clock() - startedAt) / 1000;
    if (answered && counts) {
      keycloakFenceSampleDuration.observe({ outcome: 'ok' }, took);
      keycloakFenceSamplesTotal.inc({ outcome: 'ok' });
      this.succeed(startedAt, counts);
    } else {
      keycloakFenceSampleDuration.observe({ outcome: 'failed' }, took);
      keycloakFenceSamplesTotal.inc({ outcome: 'failed' });
      if (!answered) this.fail(new Error(`no answer within ${this.budgetMs} ms`));
    }
    // Its transaction ends before this sampler starts another on its one connection.
    await settled;
  }

  private succeed(startedAt: number, counts: FenceCounts): void {
    const gap = startedAt - (this.lastSuccessAt ?? this.startedAt);
    this.lastSuccessAt = startedAt;
    this.latest = counts;
    this.retained.push({ at: startedAt, overdue: counts.overdue, expired: counts.expired, gap });
    this.prune(this.clock());
    if (this.failing) this.logger.log('Keycloak fence sampling recovered');
    this.failing = false;
  }

  private fail(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.logger.warn(
      `Keycloak fence sample failed; the fence gauges go stale until one succeeds: ${describe(error)}`,
    );
  }

  private prune(now: number): void {
    while (this.retained.length > 0 && this.retained[0]!.at < now - this.retentionMs) {
      this.retained.shift();
    }
  }

  private sampleLapses(): void {
    if (this.cancel.signal.aborted || this.lapseInFlight) return;
    const run = withCancellation(this.cancel.signal, () =>
      this.source.lapseBacklog(this.lapseBudgetMs),
    );
    const settled = run.then(
      (backlog) => membershipLapseBacklog.set(backlog),
      // Stale until the next count: the 20-minute alert tolerates one missed.
      () => undefined,
    );
    this.lapseInFlight = settled.finally(() => {
      this.lapseInFlight = undefined;
    });
  }
}

function wholeMs(ms: number): number {
  const whole = Math.ceil(ms);
  if (!Number.isSafeInteger(whole) || whole < 1) {
    throw new Error('refusing a timeout that is not a positive whole number');
  }
  return whole;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
