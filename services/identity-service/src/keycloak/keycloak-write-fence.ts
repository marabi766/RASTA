import { performance } from 'node:perf_hooks';
import { ulid } from 'ulid';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import { keycloakWriteFenceEventsTotal } from '../observability/keycloak-projection.metrics';

/**
 * The durable in-flight fence of every Keycloak write (ADR-060, write-ahead
 * addendum, D-069).
 *
 * Keycloak has no conditional write: its admin `PUT` carries no version and
 * honours no `If-Match` (measured, `keycloak.client.ts`). An aborted request is
 * not a cancelled one, so a write whose answer was lost may still be applied
 * later — after a newer write, leaving Keycloak wider than the rows. What
 * stands in for the missing version is this table: **before** any request that
 * changes a user's attributes or `enabled` flag is sent, a row for that one
 * attempt is inserted and committed, on its own connection pool, and nothing
 * but a confirmed outcome removes it.
 *
 * ## One row per attempt
 *
 * `attempt_id`, the user, the account addressed, and three instants on the
 * database's clock: `started_at` (the insert), `deadline_at` = `started_at` +
 * the Keycloak request timeout — the sender aborts by then, and re-checks it
 * immediately before dispatch (`KeycloakWriteAttempt.assertDispatchable`) —
 * and `takeover_at` = `deadline_at` + `KEYCLOAK_WRITE_SETTLE_SECONDS`.
 *
 * - **live** (`takeover_at` in the future): may still land. A narrowing change
 *   of the user is refused (`KEYCLOAK_WRITE_SETTLING`), and an account is not
 *   enabled for the first time, until none is.
 * - **due** (`takeover_at` passed): can no longer land, but what Keycloak holds
 *   is unknown. The sweep re-asserts the committed state; the projection that
 *   confirms it deletes the row.
 * - **terminal** (`account_missing_at`): Keycloak answered 404 for the account
 *   on re-assertion. Nothing can mint a token for it; kept and alerted on, no
 *   longer retried by the sweep, and taken over by the next projection of the
 *   user that lands (the account restored, or the user linked to another).
 *
 * ## Who deletes a row
 *
 * Only these, each by `attempt_id` (compare-and-delete, so a late callback can
 * never remove a newer attempt's row):
 *
 * 1. the attempt's owner, at once, when the request provably was not applied
 *    (never sent, refused 4xx, 404, its deadline passed before dispatch) —
 *    {@link KeycloakWriteFences.release};
 * 2. the owner's transaction, in the same commit as the state it wrote, when
 *    the write landed and carried exactly what that transaction commits —
 *    {@link KeycloakWriteFences.settle};
 * 3. a projection of the user whose own writes all landed, for every row that
 *    was already **due** when it read them under the user lock — its write of
 *    the committed state is the re-assertion that takes them over.
 *
 * A write that landed but whose transaction did not commit, or that carried
 * less than its transaction commits (a mixed change's intersection, an
 * adoption's clear), is not deleted: its owner makes it **due** at once
 * ({@link KeycloakWriteFences.confirmLanded}) — it landed, so it can no
 * longer land, and holds no narrowing back; what Keycloak holds is re-asserted
 * by the next projection, the owner's own after commit or the sweep's.
 *
 * A timeout, a broken connection, a 5xx, a rollback before the owner heard
 * back, an exit: the row stays live until `takeover_at`.
 *
 * ## Why the insert can never wait on the business transaction
 *
 * The business transaction holds the user lock (`"user"` row FOR UPDATE)
 * while it opens a fence. The insert runs on a **separate pool** (`pool`,
 * {@link FENCE_POOL_CONNECTIONS} connections) in a short transaction of its
 * own — one statement, bounded by what is left of the business transaction's
 * budget — and touches only this table: no foreign key to `"user"` (whose check would take FOR KEY SHARE
 * on the locked row), no trigger, a fresh primary key. So it neither waits on
 * the user lock nor for a business connection — a shared pool could be
 * exhausted by transactions queued on that same lock. The business transaction
 * reads this table without locking and deletes its own rows last, after its
 * final fence statement; a fence statement waits at most on such a delete,
 * never the other way round. Lock graph: `ADR-060`, D-069 addendum.
 *
 * ## Why the business transaction is checked again after the insert
 *
 * The insert is on another connection, so the business transaction may end —
 * its budget spent, rolled back, its connection lost — while the insert waits,
 * and the user lock pass to a narrowing that sees no fence yet and commits
 * (#402 r2 F1). So `open` returns an attempt only after one more statement in
 * the business transaction, after the insert committed, proved that
 * transaction still alive and holding the lock. Every writer that takes the
 * lock after that point reads the fence; one that took it before cannot exist.
 *
 * ## The late sender (D-070 option D)
 *
 * A sender can be paused — the process stopped, a long GC, an event-loop
 * stall — after its last deadline check and before or while its request goes
 * out, for longer than the settle window. Its PUT may then reach Keycloak after
 * its fence was taken over and a later narrowing committed: the old fence no
 * longer holds anything back. So whatever answer it then gets, a sender that
 * learns the outcome **after its own deadline** — judged on the monotonic
 * clock read after the reply ({@link KeycloakWriteAttempt.observeReply}), not
 * on any time it scheduled — does two things:
 *
 * 1. it commits a **fresh fence** for the user ({@link KeycloakWriteFences.recoverLate}):
 *    a new attempt, with its own deadline and takeover from now, under the
 *    same rules as every other row. Its outcome unknown (a timeout, a broken
 *    connection, a 5xx), the fresh row is live: the PUT may still land, and
 *    every narrowing of the user waits until a re-assertion after takeover.
 *    Its outcome known — landed, or provably not applied — its owner confirms
 *    it in the same statement (a zero window, so due at once, D-069 rule 4):
 *    nothing of it can land any more, and the next projection takes it over;
 * 2. it asks for an immediate projection of the user (the projector's
 *    recovery), which writes the committed rows under the user lock. Never
 *    awaited by the sender: the sender may still hold that lock.
 *
 * The fresh row is what makes the recovery durable: if the projection fails,
 * or the process dies, the sweep of any replica re-asserts the user from it
 * (at once when due, after takeover when live). A fresh row that cannot be
 * written — the database failed, or the sender's worker was **stopped**, so
 * its scope refuses every database operation (`prisma/cancellation.ts`) — is
 * owed: kept in this process and written by {@link KeycloakWriteFences.recoverOwed},
 * which every sweep pass calls first and every worker's stop calls before it
 * returns (outside the stopped scope, so nothing commits after a stop has
 * returned). That flush also writes a fresh row for every attempt sent and
 * still unanswered past its deadline, so a stop that abandons a paused sender
 * leaves a durable record of it.
 *
 * **What this does not cover.** A request delayed in the network, a proxy or
 * Keycloak itself after the sender's last check — the sender heard back in
 * time, or its request was in flight before the deadline and lands later than
 * the settle window — leaves no trace on the sender's clock. That remains the
 * deployment assumption F (D-070) until option A (a projection version in the
 * token, after #381 PR 2). Nor does a sender that pauses again for longer
 * than the settle window between its stop's flush and the process exit
 * (ADR-060 D-069 addendum § 7).
 */

/** Connections of the fence pool: inserts and releases are single short statements. */
export const FENCE_POOL_CONNECTIONS = 2;

/** Below this much left of the business transaction, no fence is opened: nothing is sent. */
const MIN_INSERT_BUDGET_MS = 1;

/**
 * The bound of a late sender's fresh fence (D-070 D): the wait for a fence
 * connection, the statement and its transaction. It holds no user lock, so it
 * is bounded on its own; one that fails is owed and written again later.
 */
export const LATE_FENCE_BUDGET_MS = 5_000;

/** How long the current transaction has run, in milliseconds, on the database clock. */
const AGE_OF_TRANSACTION_MS = Prisma.sql`(EXTRACT(EPOCH FROM clock_timestamp() - transaction_timestamp()) * 1000)::float8`;

/**
 * The durable backoffs' bounds (#402 r2 F4): the exponent is capped **before**
 * `POWER` — `2^31` is far above any cap of scan intervals and far below
 * double precision's range — and the failure counter itself stops at
 * {@link BACKOFF_FAILURES_CAP}, well inside `INTEGER`, so neither the
 * arithmetic nor the counter can overflow however long a row keeps failing.
 * Shared with the expiry sweep's `deferLapse`.
 */
export const BACKOFF_EXPONENT_CAP = 30;
export const BACKOFF_FAILURES_CAP = 1_000_000;

/** What one attempt writes. */
export type KeycloakWriteOperation = 'replace_attributes' | 'activate' | 'disable';

/**
 * One PUT's fence, committed: what the client needs to send it, and nothing
 * about the database.
 */
export interface KeycloakWriteAttempt {
  readonly id: string;
  /** Aborts at the attempt's deadline, or when the caller is cancelled. */
  readonly signal: AbortSignal;
  /**
   * Throws a confirmed not-sent failure when the deadline has passed or the
   * caller was cancelled. Called immediately before the request is dispatched.
   */
  assertDispatchable(): void;
  /**
   * Called as soon as the request's outcome is known — an answer, or a
   * failure after dispatch. Reads the monotonic clock **now** (the first call
   * only; later calls return the same verdict) and returns whether the
   * attempt's deadline had passed by then: a late sender (D-070 option D).
   * False for an attempt never dispatched.
   */
  observeReply(): boolean;
}

/** What a late sender's fresh fence needs to know of the attempt it stands in for. */
interface SentWrite {
  attemptId: string;
  userId: string;
  keycloakId: string;
  operation: KeycloakWriteOperation;
  timeoutMs: number;
  settleSeconds: number;
  /** On the monotonic clock. */
  deadline: number;
  /** A flush already wrote a fresh fence for it while it was unanswered. */
  flushed?: boolean;
}

/**
 * A fresh fence not yet written — an **obligation** — and whether the late
 * attempt's outcome is known. Never changed once made: what it says changes
 * only by a newer obligation for the same attempt, with a newer `generation`.
 */
interface OwedFence extends SentWrite {
  readonly known: boolean;
  /**
   * Which obligation of its attempt this is (#458 r1 F1). A write that
   * succeeds clears the obligation only while it is still this generation:
   * one that a later reply replaced — a fence already taken over and
   * repaired, then the sender hearing back late — is never erased by the
   * completion of a write made for the one before it.
   */
  readonly generation: number;
}

export interface KeycloakWriteFencesOptions {
  /**
   * The monotonic clock every attempt's deadline is kept on, in milliseconds:
   * `performance.now`, which keeps running across a process stop or a GC
   * pause. A test pauses a sender by moving its own.
   */
  monotonicNow?: () => number;
}

/**
 * What a Keycloak write method asks for right before its PUT (after the token
 * and the read it builds the body from): an attempt whose fence has committed.
 * Required by every write method of `KeycloakAdminClient`, so no PUT can be
 * sent without one.
 */
export type KeycloakWriteFence = (
  operation: KeycloakWriteOperation,
) => Promise<KeycloakWriteAttempt>;

/** A fence row as a writer under the user lock reads it. */
export interface FenceRow {
  attemptId: string;
  keycloakId: string;
  operation: KeycloakWriteOperation;
  /** `takeover_at` has not passed: the write may still land. */
  live: boolean;
  /** Terminal: the account was missing on re-assertion. */
  accountMissing: boolean;
  /** Seconds until `takeover_at`, rounded up; 0 once it has passed. */
  settlesInSeconds: number;
}

/**
 * The deadline passed, the caller was cancelled, or the business transaction
 * ended while the fence was being committed (#402 r2 F1), before the request
 * was sent: provably not applied.
 */
export function writeNotSent(
  operation: string,
  reason: 'deadline' | 'cancelled' | 'transaction_ended',
): RastaError {
  return new RastaError(
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    'A required service is temporarily unavailable',
    { internalContext: { service: 'keycloak', operation, reason: `${reason}_before_dispatch` } },
  );
}

/** Every fence row, counted by state as of one database instant ({@link fenceCounts}). */
export interface FenceCounts {
  live: number;
  due: number;
  accountMissing: number;
  overdue: number;
  expired: number;
  total: number;
  /** The database instant every row was judged as of. */
  at: Date;
}

/**
 * How many fences are live, due and terminal, and two subsets that matter
 * for the D-070 deployment assumption:
 *
 * - `overdue` (live): unresolved past the deadline plus half the settle
 *   window (`deadline_at + (takeover_at - deadline_at) / 2`), not yet past
 *   takeover. Such a write timed out, broke off, was answered 5xx, or its
 *   sender is paused; the settle window is all that keeps a late delivery of
 *   it from landing after takeover (ADR-060 D-069 § 6). The definition is
 *   #402's, unchanged.
 * - `expired` (due, not terminal): past takeover with its outcome never
 *   learned — a window that still has width (`deadline_at < takeover_at`;
 *   an owner that confirmed its write collapsed it, `confirmLanded`) — and
 *   not re-asserted yet. What an `overdue` fence becomes at takeover, until
 *   the sweep repairs it: so a window that closed still leaves a trace.
 *
 * `total` is every row, whatever its state: the rollback's readiness check
 * (zero rows). One full aggregate — never a page. As of the database's
 * clock now; `at` judges every row as of that one instant instead.
 *
 * The one clock row is outer-joined to the table, so an empty table still
 * yields its instant: every count is of `attempt_id` — never `COUNT(*)`,
 * which would count that clock row as a fence (#458 r1 F4).
 */
export async function fenceCounts(
  client: Pick<ExtendedPrismaClient, '$queryRaw'>,
  at?: Date,
): Promise<FenceCounts> {
  const instant =
    at === undefined ? Prisma.sql`clock_timestamp() AT TIME ZONE 'UTC'` : Prisma.sql`${at}`;
  const rows = await client.$queryRaw<
    Array<{
      live: bigint;
      due: bigint;
      account_missing: bigint;
      overdue: bigint;
      expired: bigint;
      total: bigint;
      now: Date;
    }>
  >`
    SELECT COUNT(attempt_id) FILTER (WHERE takeover_at > t.now) AS live,
           COUNT(attempt_id) FILTER (
             WHERE takeover_at <= t.now AND account_missing_at IS NULL) AS due,
           COUNT(attempt_id) FILTER (WHERE account_missing_at IS NOT NULL) AS account_missing,
           COUNT(attempt_id) FILTER (
             WHERE takeover_at > t.now
               AND t.now >= deadline_at + (takeover_at - deadline_at) / 2) AS overdue,
           COUNT(attempt_id) FILTER (
             WHERE takeover_at <= t.now
               AND deadline_at < takeover_at
               AND account_missing_at IS NULL) AS expired,
           COUNT(attempt_id) AS total,
           t.now AS now
      FROM (SELECT ${instant} AS now) t
      LEFT JOIN keycloak_write_attempt ON true
     GROUP BY t.now`;
  const row = rows[0];
  return {
    live: Number(row?.live ?? 0),
    due: Number(row?.due ?? 0),
    accountMissing: Number(row?.account_missing ?? 0),
    overdue: Number(row?.overdue ?? 0),
    expired: Number(row?.expired ?? 0),
    total: Number(row?.total ?? 0),
    at: row?.now ?? new Date(Number.NaN),
  };
}

export class KeycloakWriteFences {
  private readonly monotonicNow: () => number;
  /** Attempts dispatched whose outcome is not known yet, by attempt id (this process). */
  private readonly sent = new Map<string, SentWrite>();
  /**
   * Late attempts whose fresh fence is not written yet, by the late attempt's
   * id: the newest obligation of each. Replaced only through {@link owe},
   * cleared only through {@link discharge}.
   */
  private readonly owed = new Map<string, OwedFence>();
  /** The last obligation's generation, in this process. */
  private generations = 0;
  /**
   * The flushes, one after another, so two never write the same fresh fence
   * twice; each runs in its own caller's scope, so a stop's flush is never
   * the cancelled one of the pass it stopped.
   */
  private flushes: Promise<unknown> = Promise.resolve();

  /**
   * @param pool the fence pool — a `PrismaService` of its own, never the one
   *   business transactions run on (see the header).
   */
  constructor(
    private readonly pool: PrismaService,
    options: KeycloakWriteFencesOptions = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  /** Fresh fences of late senders still to be written in this process (D-070 D). */
  get owedCount(): number {
    return this.owed.size;
  }

  /**
   * Inserts and commits one attempt's fence, then returns it. `tx` must hold
   * the user lock: it is taken again here (a no-op for its holder), so a fence
   * is only ever opened by the user's one writer, and a reader under the lock
   * sees every fence of every write that can be in flight.
   *
   * **After the insert commits, `tx` is checked again** (#402 r2 F1): one
   * more statement in that same transaction re-takes the user lock without
   * waiting (`NOWAIT`) and reads the transaction's age on the database clock.
   * Only if it succeeds — so the transaction was still alive, still held the
   * lock, and had budget left **after** the fence became visible — is the
   * attempt returned. From then on the fence protects every lock handoff: a
   * writer that takes the lock after this transaction ends reads it. If the
   * transaction ended while the insert waited (expired, rolled back, its
   * connection lost), the lock may already have passed to a narrowing that
   * saw no fence and committed: then **nothing is sent** — the attempt never
   * leaves this method, so no request of it can ever be dispatched — and its
   * row, provably not applied, is released at once (a failed release leaves
   * it live until takeover: slower, never unsafe).
   *
   * The insert is bounded by what remains of the business transaction's
   * budget (`transactionTimeoutMs`, measured on the database clock from the
   * transaction's start): its wait for a fence connection, its statement and
   * its own transaction. An insert that cannot commit while the business
   * transaction can still use it is abandoned, and nothing is sent.
   *
   * The local deadline is measured from **before** the insert, so it falls no
   * later, in real time, than the `deadline_at` the database stamps.
   */
  async open(
    tx: ExtendedPrismaClient,
    input: {
      userId: string;
      keycloakId: string;
      operation: KeycloakWriteOperation;
      timeoutMs: number;
      settleSeconds: number;
      /** The budget `tx` was opened with (its Prisma `timeout`). */
      transactionTimeoutMs: number;
      cancel?: AbortSignal;
    },
  ): Promise<KeycloakWriteAttempt> {
    const operation = input.operation;
    input.cancel?.throwIfAborted();
    const held = await tx.$queryRaw<Array<{ elapsed_ms: number }>>`
      SELECT ${AGE_OF_TRANSACTION_MS} AS elapsed_ms FROM "user" WHERE id = ${input.userId} FOR UPDATE`;
    if (held.length !== 1) throw RastaError.notFound('User', input.userId);
    input.cancel?.throwIfAborted();
    // Whole milliseconds the business transaction may still use the fence for.
    const elapsed = Number(held[0]?.elapsed_ms ?? Number.POSITIVE_INFINITY);
    const budget = Math.floor(input.transactionTimeoutMs - elapsed);
    if (budget < MIN_INSERT_BUDGET_MS) throw writeNotSent(operation, 'transaction_ended');

    const attemptId = `KWA_${ulid()}`;
    const startedAt = this.monotonicNow();
    const timeout = input.timeoutMs / 1000;
    // A failure here throws, and nothing is sent. The insert's own transaction
    // rolled back; should its COMMIT have landed all the same (an answer lost
    // on the fence connection), the row is an ordinary live fence no attempt
    // owns — it holds narrowing back until `takeover_at`, then the sweep
    // re-asserts: never unsafe. Not released here: a release would wait on
    // whatever made the insert miss its budget.
    await this.pool.transaction(
      (fence) => fence.$executeRaw`
        INSERT INTO keycloak_write_attempt
               (attempt_id, user_id, keycloak_id, operation,
                started_at, deadline_at, takeover_at, next_reassert_at)
        SELECT ${attemptId}, ${input.userId}, ${input.keycloakId}, ${input.operation},
               t.c, t.c + make_interval(secs => ${timeout}),
               t.c + make_interval(secs => ${timeout + input.settleSeconds}),
               t.c + make_interval(secs => ${timeout + input.settleSeconds})
          FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`,
      // One budget for the connection wait and the insert together (#458 r2
      // F2): never past what the business transaction has left.
      { budgetMs: budget, statementTimeoutMs: budget },
    );

    // The fence is visible to every later reader. Is `tx` still the one
    // holding the user lock? Checked in `tx` itself, on the database clock.
    let alive = false;
    try {
      const again = await tx.$queryRaw<Array<{ elapsed_ms: number }>>`
        SELECT ${AGE_OF_TRANSACTION_MS} AS elapsed_ms
          FROM "user" WHERE id = ${input.userId} FOR UPDATE NOWAIT`;
      alive =
        again.length === 1 &&
        Number(again[0]?.elapsed_ms ?? Number.POSITIVE_INFINITY) < input.transactionTimeoutMs;
    } catch {
      alive = false;
    }
    if (!alive) {
      const released = await this.release(attemptId);
      keycloakWriteFenceEventsTotal.inc({ event: 'lock_lost' });
      keycloakWriteFenceEventsTotal.inc({ event: released ? 'released' : 'release_failed' });
      throw writeNotSent(operation, 'transaction_ended');
    }

    const deadline = startedAt + input.timeoutMs;
    const clock = this.monotonicNow;
    // Whole milliseconds, rounded down: never later than the deadline.
    const remaining = Math.max(0, Math.floor(deadline - clock()));
    const timer = AbortSignal.timeout(remaining);
    const signal = input.cancel ? AbortSignal.any([timer, input.cancel]) : timer;
    const write: SentWrite = {
      attemptId,
      userId: input.userId,
      keycloakId: input.keycloakId,
      operation,
      timeoutMs: input.timeoutMs,
      settleSeconds: input.settleSeconds,
      deadline,
    };
    const { sent } = this;
    const owe = (known: boolean) => this.owe(write, known);
    let dispatched = false;
    /** The monotonic instant the outcome became known; null until then. */
    let repliedAt: number | null = null;
    return {
      id: attemptId,
      signal,
      assertDispatchable(): void {
        if (input.cancel?.aborted) throw writeNotSent(operation, 'cancelled');
        if (clock() >= deadline || timer.aborted) throw writeNotSent(operation, 'deadline');
        dispatched = true;
        sent.set(attemptId, write);
      },
      observeReply(): boolean {
        if (!dispatched) return false;
        if (repliedAt === null) {
          // After the reply, never before: a sender paused anywhere between
          // its last check and this point is late, however punctual the
          // request it scheduled was (D-070 D).
          repliedAt = clock();
          sent.delete(attemptId);
          // Owed from this instant, as unknown — the conservative reading —
          // until its sender says what it heard (`recoverLate`); a flush that
          // runs first writes it live.
          // A new obligation, whatever a flush already wrote for it while it
          // was unanswered: that fence may since have been taken over.
          if (repliedAt >= deadline) owe(false);
        }
        return repliedAt >= deadline;
      },
    };
  }

  /**
   * A late sender's fresh fence (D-070 option D, see the header): a new
   * attempt for the same user and account, its deadline and takeover counted
   * from now on the database's clock. `known` — the late attempt landed, or
   * provably was not applied — confirms it in the same statement: a zero
   * window (`deadline_at = takeover_at`), due at once, so the next projection
   * takes it over. Unknown, it is live until its own takeover.
   *
   * On the fence pool, in a short transaction of its own, under no user lock
   * — the sender may still hold that lock, or may have lost it long ago — and
   * bounded by {@link LATE_FENCE_BUDGET_MS}. Never throws: a fence that cannot
   * be written (the database failed, or the sender's worker was stopped and
   * its scope refuses it) is owed, and {@link recoverOwed} writes it.
   *
   * Never deletes or shortens any other row: the late attempt's own row, and
   * any fence of a newer attempt, are left exactly as they are.
   *
   * What its sender heard makes a new obligation (a new generation): a flush
   * still writing the one before it can no longer clear this one.
   */
  async recoverLate(attempt: KeycloakWriteAttempt, known: boolean): Promise<boolean> {
    const pending = this.owed.get(attempt.id);
    // Not owed: not late, or a flush already wrote it (live: the safe reading).
    if (!pending) return true;
    keycloakWriteFenceEventsTotal.inc({ event: 'late_reply' });
    const obligation = this.owe(pending, known);
    if (await this.writeFresh(obligation)) {
      this.discharge(obligation);
      return true;
    }
    keycloakWriteFenceEventsTotal.inc({ event: 'late_owed' });
    return false;
  }

  /** A new obligation for this attempt, replacing any older one: the next generation. */
  private owe(write: SentWrite, known: boolean): OwedFence {
    const obligation: OwedFence = { ...write, known, generation: ++this.generations };
    this.owed.set(write.attemptId, obligation);
    return obligation;
  }

  /**
   * Its fresh fence is committed: clears the obligation — only if it is still
   * the newest of its attempt (#458 r1 F1). A newer one stays owed.
   */
  private discharge(obligation: OwedFence): void {
    if (this.owed.get(obligation.attemptId)?.generation === obligation.generation) {
      this.owed.delete(obligation.attemptId);
    }
  }

  /**
   * Writes every fresh fence this process owes (D-070 D): those a late sender
   * could not write, and one for each attempt sent and still unanswered past
   * its deadline — a sender paused right now, whose stop must not leave it
   * without a record. Called first by every sweep pass (the retry), and by
   * every worker's stop after its work unwound or was abandoned, before the
   * stop returns. Returns how many are still owed; never throws.
   *
   * Each write is bounded by one budget for its connection wait and its
   * insert together, never past what is left of the scope it runs in (a
   * stop's deadline less its COMMIT reserve, `transactionBounds`), and
   * refused once that scope is cancelled or past it (`prisma/cancellation.ts`,
   * #458 r1/r2 F2): a stop's flush begins, inserts and commits nothing after
   * the stop returned, and a COMMIT it already sent is waited for first.
   */
  recoverOwed(): Promise<number> {
    const flush = this.flushes.then(() => this.flush());
    this.flushes = flush.catch(() => undefined);
    return flush;
  }

  private async flush(): Promise<number> {
    const now = this.monotonicNow();
    for (const write of [...this.sent.values()]) {
      if (now < write.deadline || write.flushed || this.owed.has(write.attemptId)) continue;
      // Still unanswered past its deadline: its outcome is unknown. Once: if
      // its sender later hears back late, it writes a fresh fence of its own.
      write.flushed = true;
      this.owe(write, false);
    }
    for (const id of [...this.owed.keys()]) {
      // The newest obligation as of now: one replaced since the loop began
      // is written as it is now, never as it was.
      const owed = this.owed.get(id);
      if (owed && (await this.writeFresh(owed))) this.discharge(owed);
    }
    return this.owed.size;
  }

  private async writeFresh(owed: OwedFence): Promise<boolean> {
    const attemptId = `KWA_${ulid()}`;
    const timeout = owed.timeoutMs / 1000;
    try {
      await this.pool.transaction(
        (fence) => fence.$executeRaw`
          INSERT INTO keycloak_write_attempt
                 (attempt_id, user_id, keycloak_id, operation,
                  started_at, deadline_at, takeover_at, next_reassert_at)
          SELECT ${attemptId}, ${owed.userId}, ${owed.keycloakId}, ${owed.operation},
                 t.c, w.deadline, w.takeover, w.takeover
            FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t,
                 LATERAL (SELECT
                   CASE WHEN ${owed.known} THEN t.c
                        ELSE t.c + make_interval(secs => ${timeout}) END AS deadline,
                   CASE WHEN ${owed.known} THEN t.c
                        ELSE t.c + make_interval(secs => ${timeout + owed.settleSeconds}) END
                     AS takeover) w`,
        // One budget, its connection wait and its insert together — and never
        // past a stop's deadline (`transactionBounds`, #458 r2 F2); nothing
        // left, nothing begins (refused, so owed).
        { budgetMs: LATE_FENCE_BUDGET_MS, statementTimeoutMs: LATE_FENCE_BUDGET_MS },
      );
      keycloakWriteFenceEventsTotal.inc({ event: 'late_fenced' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes one attempt's fence because its request provably was not applied.
   * On the fence pool, at once, whatever the business transaction does next.
   * A delete that fails leaves the row, which only holds narrowing back until
   * the sweep takes it over: never unsafe.
   */
  async release(attemptId: string): Promise<boolean> {
    try {
      await this.pool.client.$executeRaw`
        DELETE FROM keycloak_write_attempt WHERE attempt_id = ${attemptId}`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * These attempts **landed** — confirmed — but are not deleted with their
   * transaction: makes them due now, so they hold no narrowing back and the
   * next projection of the user takes them over. On the fence pool; an update
   * that fails leaves them live until `takeover_at` — slower, never unsafe.
   * Only ever shortens a fence, and only an attempt's own owner calls it.
   *
   * Its window collapses: `deadline_at = takeover_at` (the earlier of the old
   * takeover and now). A zero window is how a row says its outcome was
   * **resolved** — every unresolved row keeps `takeover_at = deadline_at +`
   * the settle window, at least 15 s — so a due row whose outcome was never
   * learned (`expired`, {@link fenceCounts}) is told apart without a column.
   */
  async confirmLanded(attemptIds: readonly string[]): Promise<boolean> {
    if (attemptIds.length === 0) return true;
    try {
      await this.pool.client.$executeRaw`
        UPDATE keycloak_write_attempt
           SET deadline_at = LEAST(takeover_at, t.c),
               takeover_at = LEAST(takeover_at, t.c),
               next_reassert_at = LEAST(next_reassert_at, t.c)
          FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t
         WHERE attempt_id = ANY(${[...attemptIds]}::text[])`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every fence of the user, read in `tx` under the user lock, judged against
   * `now` — the database's clock, read after that lock.
   */
  async ofUser(tx: ExtendedPrismaClient, userId: string, now: Date): Promise<FenceRow[]> {
    const rows = await tx.$queryRaw<
      Array<{
        attempt_id: string;
        keycloak_id: string;
        operation: KeycloakWriteOperation;
        live: boolean;
        account_missing: boolean;
        settles_in: number;
      }>
    >`
      SELECT attempt_id, keycloak_id, operation,
             takeover_at > ${now} AS live,
             account_missing_at IS NOT NULL AS account_missing,
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM takeover_at - ${now})))::int AS settles_in
        FROM keycloak_write_attempt
       WHERE user_id = ${userId}
       ORDER BY takeover_at ASC, attempt_id ASC`;
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      keycloakId: row.keycloak_id,
      operation: row.operation,
      live: row.live,
      accountMissing: row.account_missing,
      settlesInSeconds: row.settles_in,
    }));
  }

  /**
   * Deletes these attempts' fences in `tx` — so only if `tx` commits, and in
   * the same commit as the state their writes carried. The caller's last fence
   * statement: nothing on the fence pool may follow it in that transaction.
   */
  async settle(
    tx: ExtendedPrismaClient,
    userId: string,
    attemptIds: readonly string[],
  ): Promise<void> {
    if (attemptIds.length === 0) return;
    await tx.$executeRaw`
      DELETE FROM keycloak_write_attempt
       WHERE user_id = ${userId} AND attempt_id = ANY(${[...attemptIds]}::text[])`;
  }

  /**
   * Users with a fence past takeover and due for another re-assertion,
   * walked by user id (byte order) strictly after `after` and, when given, up
   * to `until`: the sweep's cursor across passes and its one wrap round.
   * Terminal fences are not retried.
   */
  async dueUsers(
    after: string | null,
    take: number,
    until: string | null = null,
  ): Promise<string[]> {
    const rows = await this.pool.client.$queryRaw<Array<{ user_id: string }>>`
      SELECT DISTINCT user_id COLLATE "C" AS user_id FROM keycloak_write_attempt
       WHERE account_missing_at IS NULL
         AND takeover_at <= (clock_timestamp() AT TIME ZONE 'UTC')
         AND next_reassert_at <= (clock_timestamp() AT TIME ZONE 'UTC')
         AND (${after}::text IS NULL OR user_id COLLATE "C" > ${after}::text)
         AND (${until}::text IS NULL OR user_id COLLATE "C" <= ${until}::text)
       ORDER BY 1 ASC
       LIMIT ${take}`;
    return rows.map((row) => row.user_id);
  }

  /**
   * One more failed re-assertion of the user: their due fences wait twice as
   * long as last time, up to `maxIntervals` scan intervals, before the next.
   * The exponent and the counter are bounded first ({@link BACKOFF_EXPONENT_CAP}).
   * Durable, so neither a restart nor another replica tries them sooner, and
   * the sweep moves on to the users behind them.
   */
  async deferReassert(
    userId: string,
    intervalSeconds: number,
    maxIntervals: number,
  ): Promise<void> {
    await this.pool.client.$executeRaw`
      UPDATE keycloak_write_attempt
         SET reassert_failures = LEAST(reassert_failures, ${BACKOFF_FAILURES_CAP - 1}) + 1,
             next_reassert_at = (clock_timestamp() AT TIME ZONE 'UTC')
               + make_interval(secs => ${intervalSeconds}
                   * LEAST(POWER(2, LEAST(reassert_failures, ${BACKOFF_EXPONENT_CAP}) + 1),
                           ${maxIntervals}))
       WHERE user_id = ${userId}
         AND account_missing_at IS NULL
         AND takeover_at <= (clock_timestamp() AT TIME ZONE 'UTC')`;
  }

  /**
   * Terminal: these due fences' account is gone from Keycloak (404). They stop
   * being retried, stay in the table, and are counted and alerted on
   * (`rasta_identity_keycloak_write_fences{state="account_missing"}`). On the
   * fence pool, so the record survives whatever the caller's transaction does.
   */
  async markAccountMissing(attemptIds: readonly string[]): Promise<void> {
    if (attemptIds.length === 0) return;
    await this.pool.client.$executeRaw`
      UPDATE keycloak_write_attempt
         SET account_missing_at = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE attempt_id = ANY(${[...attemptIds]}::text[]) AND account_missing_at IS NULL`;
  }

  /**
   * Every row counted by state, on the fence pool ({@link fenceCounts}): the
   * backfill's report, and its rollback readiness (`total`).
   */
  counts(at?: Date): Promise<FenceCounts> {
    return fenceCounts(this.pool.client, at);
  }

  /**
   * Every user that owns a fence — live, due, waiting out a retry, or
   * terminal; linked to an account or not — walked by user id (byte order)
   * strictly after `after`: the backfill's drain (#402 r2 F3), which must
   * reach every row the down migration would refuse on.
   */
  async owners(after: string | null, take: number): Promise<string[]> {
    const rows = await this.pool.client.$queryRaw<Array<{ user_id: string }>>`
      SELECT DISTINCT user_id COLLATE "C" AS user_id FROM keycloak_write_attempt
       WHERE (${after}::text IS NULL OR user_id COLLATE "C" > ${after}::text)
       ORDER BY 1 ASC
       LIMIT ${take}`;
    return rows.map((row) => row.user_id);
  }
}
