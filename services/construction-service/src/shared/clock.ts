import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The one instant a transaction is allowed to call "now".
 *
 * ## Why this exists (D-5)
 *
 * This service persists facts whose timestamps are compared to each other by
 * CHECK constraints — `decided_at >= submitted_at`, `reinstated_at >=
 * suspended_at` — and announces those same facts in events that carry the
 * timestamp again. Before this helper, the two sides of those comparisons came
 * from **different clocks**: `submitted_at` and `registered_at` from PostgreSQL
 * via `@default(now())`, `decided_at` and `suspended_at` from Node via
 * `new Date()`, and the event's `occurredAt` from a third `new Date()` taken at
 * a different moment again.
 *
 * Nothing guarantees those clocks agree. They are different processes, usually
 * different containers, and NTP steps them independently. Two consequences,
 * both observed rather than theorised (`test/clock.int-spec.ts`):
 *
 *   1. With the application clock trailing the database clock, approving a
 *      qualification submitted seconds earlier violates
 *      `ck_qualification_decided_after_submitted` and returns a 500 for an
 *      operation that was entirely legitimate.
 *   2. A row and the event announcing it recorded the same fact at two
 *      different times, so a consumer's timeline disagreed with the owning
 *      service's.
 *
 * ## Why the database, and why `now()`
 *
 * The database is the authority because it is the thing that *evaluates* the
 * constraints. A timestamp it produced can never be inconsistent with a
 * timestamp it produced a moment earlier, whatever the application's clock is
 * doing.
 *
 * `now()` is PostgreSQL's transaction start time and is **constant for the
 * whole transaction** — that is the property being relied on, not an accident.
 * Calling this twice inside one transaction returns the same instant, so a row
 * and the event announcing it cannot drift apart even by a millisecond.
 * `clock_timestamp()` would advance between calls and reintroduce exactly the
 * disagreement this removes.
 *
 * ## What this does not do
 *
 * It does not weaken a constraint. `decided_at >= submitted_at` still holds and
 * still rejects a decision that genuinely predates its submission; what changed
 * is that both sides now come from the same clock, so the comparison measures
 * the domain rather than the infrastructure.
 */
export async function transactionNow(tx: ExtendedPrismaClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now');
  const now = rows[0]?.now;
  if (!(now instanceof Date)) {
    // Unreachable against PostgreSQL, and deliberately loud rather than a
    // silent `new Date()` fallback: falling back to the application clock is
    // the exact defect this function exists to remove.
    throw new Error(
      'SELECT now() did not return a timestamp; refusing to fall back to the application clock',
    );
  }
  return now;
}
