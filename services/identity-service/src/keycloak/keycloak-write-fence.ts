import { performance } from 'node:perf_hooks';
import { ulid } from 'ulid';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';

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
 * {@link FENCE_POOL_CONNECTIONS} connections) in autocommit, and touches only
 * this table: no foreign key to `"user"` (whose check would take FOR KEY SHARE
 * on the locked row), no trigger, a fresh primary key. So it neither waits on
 * the user lock nor for a business connection — a shared pool could be
 * exhausted by transactions queued on that same lock. The business transaction
 * reads this table without locking and deletes its own rows last, after its
 * final fence statement; a fence statement waits at most on such a delete,
 * never the other way round. Lock graph: `ADR-060`, D-069 addendum.
 */

/** Connections of the fence pool: inserts and releases are single short statements. */
export const FENCE_POOL_CONNECTIONS = 2;

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

/** The deadline passed, or the caller was cancelled, before the request was sent: provably not applied. */
export function writeNotSent(operation: string, reason: 'deadline' | 'cancelled'): RastaError {
  return new RastaError(
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    'A required service is temporarily unavailable',
    { internalContext: { service: 'keycloak', operation, reason: `${reason}_before_dispatch` } },
  );
}

export class KeycloakWriteFences {
  /**
   * @param pool the fence pool — a `PrismaService` of its own, never the one
   *   business transactions run on (see the header).
   */
  constructor(private readonly pool: PrismaService) {}

  /**
   * Inserts and commits one attempt's fence, then returns it. `tx` must hold
   * the user lock: it is taken again here (a no-op for its holder), so a fence
   * is only ever opened by the user's one writer, and a reader under the lock
   * sees every fence of every write that can be in flight.
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
      cancel?: AbortSignal;
    },
  ): Promise<KeycloakWriteAttempt> {
    input.cancel?.throwIfAborted();
    const held = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "user" WHERE id = ${input.userId} FOR UPDATE`;
    if (held.length !== 1) throw RastaError.notFound('User', input.userId);
    input.cancel?.throwIfAborted();

    const attemptId = `KWA_${ulid()}`;
    const startedAt = performance.now();
    const timeout = input.timeoutMs / 1000;
    await this.pool.client.$executeRaw`
      INSERT INTO keycloak_write_attempt
             (attempt_id, user_id, keycloak_id, operation,
              started_at, deadline_at, takeover_at, next_reassert_at)
      SELECT ${attemptId}, ${input.userId}, ${input.keycloakId}, ${input.operation},
             t.c, t.c + make_interval(secs => ${timeout}),
             t.c + make_interval(secs => ${timeout + input.settleSeconds}),
             t.c + make_interval(secs => ${timeout + input.settleSeconds})
        FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`;

    const deadline = startedAt + input.timeoutMs;
    // Whole milliseconds, rounded down: never later than the deadline.
    const remaining = Math.max(0, Math.floor(deadline - performance.now()));
    const timer = AbortSignal.timeout(remaining);
    const signal = input.cancel ? AbortSignal.any([timer, input.cancel]) : timer;
    const operation = input.operation;
    return {
      id: attemptId,
      signal,
      assertDispatchable(): void {
        if (input.cancel?.aborted) throw writeNotSent(operation, 'cancelled');
        if (performance.now() >= deadline || timer.aborted)
          throw writeNotSent(operation, 'deadline');
      },
    };
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
   */
  async confirmLanded(attemptIds: readonly string[]): Promise<boolean> {
    if (attemptIds.length === 0) return true;
    try {
      await this.pool.client.$executeRaw`
        UPDATE keycloak_write_attempt
           SET deadline_at = LEAST(deadline_at, t.c),
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
         SET reassert_failures = reassert_failures + 1,
             next_reassert_at = (clock_timestamp() AT TIME ZONE 'UTC')
               + make_interval(secs => ${intervalSeconds}
                   * LEAST(POWER(2, reassert_failures + 1), ${maxIntervals}))
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

  /** How many fences are live, due and terminal: the sweep's gauges. */
  async counts(): Promise<{ live: number; due: number; accountMissing: number }> {
    const rows = await this.pool.client.$queryRaw<
      Array<{ live: bigint; due: bigint; account_missing: bigint }>
    >`
      SELECT COUNT(*) FILTER (WHERE takeover_at > t.now) AS live,
             COUNT(*) FILTER (WHERE takeover_at <= t.now AND account_missing_at IS NULL) AS due,
             COUNT(*) FILTER (WHERE account_missing_at IS NOT NULL) AS account_missing
        FROM keycloak_write_attempt, (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now) t`;
    const row = rows[0];
    return {
      live: Number(row?.live ?? 0),
      due: Number(row?.due ?? 0),
      accountMissing: Number(row?.account_missing ?? 0),
    };
  }
}
