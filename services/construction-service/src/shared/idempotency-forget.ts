import type { Prisma } from '../generated/prisma';

/**
 * When may the store FORGET a key row (PM decision D-067)? One rule, read by every path that removes
 * or reclaims a row for expiry — the claim's reclaim of an expired row (whether the request that
 * found it matches the stored one or not) and the scheduled purge — so no path can shorten what
 * another keeps.
 *
 * Let `now` be the deciding replica's clock and `B` the fence budget (`replayFenceBudgetMs`):
 *
 *     row with a stored replay deadline   forget  ⇔  expiresAt <  now − B     (strict)
 *     row without one (written before the fence, or sent without the header)
 *                                         forget  ⇔  expiresAt ≤  now         (today's reclaim rule)
 *
 * The scheduled purge used `<` for the second case and the reclaim `≤`; they are one rule now (`≤`):
 * a null-deadline row at exactly `expiresAt` is already expired for the claim, so the purge may take
 * it a millisecond earlier without changing what any request meets.
 *
 * Why the first line is safe is argued where the deadline is stored (`shared/idempotency.ts`, the
 * replay fence): an accepted header satisfies `H ≤ C + TTL − B`, the row's `expiresAt` is `C + TTL`,
 * and nothing forgets before `expiresAt + B`.
 *
 * The rule is expressed TWICE with one meaning: {@link mayForget} for the in-memory decision whether
 * to try, and {@link forgettableWhere} as the predicate every DELETE carries in its own `WHERE`, so
 * the decision is made by the database on the row as it is at delete time — not on a copy read
 * earlier. `idempotency-forget.int-spec.ts` evaluates both over a boundary grid on real PostgreSQL
 * and asserts they agree; a source test asserts that every `deleteMany` on the key table but the
 * owner's own release goes through {@link forgettableWhere}.
 *
 * NOT covered, deliberately: `IdempotencyStore.release` — the token-owned removal of the caller's
 * OWN `IN_PROGRESS` claim after its work failed and rolled back. It can only remove a claim whose
 * work never committed (a completed claim has left `IN_PROGRESS`), so there is nothing to replay.
 */
export interface ForgettableRow {
  readonly expiresAt: Date;
  readonly replayDeadlineAt: Date | null;
}

export function mayForget(row: ForgettableRow, nowMs: number, budgetMs: number): boolean {
  return row.replayDeadlineAt === null
    ? row.expiresAt.getTime() <= nowMs
    : row.expiresAt.getTime() < nowMs - budgetMs;
}

/** {@link mayForget} as the `WHERE` of a delete. */
export function forgettableWhere(nowMs: number, budgetMs: number): Prisma.IdempotencyKeyWhereInput {
  return {
    OR: [
      { replayDeadlineAt: null, expiresAt: { lte: new Date(nowMs) } },
      { replayDeadlineAt: { not: null }, expiresAt: { lt: new Date(nowMs - budgetMs) } },
    ],
  };
}
