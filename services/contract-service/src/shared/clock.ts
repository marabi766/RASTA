import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The one instant a transaction is allowed to call "now" (D-5).
 *
 * A contract row carries timestamps that CHECK constraints compare with each other
 * (`ck_contract_timestamps_ordered`: nothing predates the creation), and the event
 * announcing a draft carries the same instant again. If those came from different clocks —
 * PostgreSQL's `now()` for one, Node's `new Date()` for another — nothing would guarantee
 * they agree: different processes, usually different containers, NTP stepping each
 * independently. A legitimate write could then violate its own constraint, and the row and
 * the event would record one fact at two different times.
 *
 * The database is the authority because it is the thing that *evaluates* the constraints,
 * and `now()` is the transaction's start time, **constant for the whole transaction**: a row
 * and the event announcing it cannot drift apart by a millisecond. `clock_timestamp()` would
 * advance between calls and reintroduce the disagreement.
 *
 * It does not weaken a constraint: what changed is that both sides of every comparison come
 * from one clock, so the comparison measures the domain rather than the infrastructure.
 */
/**
 * The database's clock **now**, advancing inside a transaction — `clock_timestamp()` — for the one
 * thing that must not be the transaction's start: the instant a question was asked of another
 * service in the middle of it (`ContractService.authorityOf`, D-050). Never stamped on a row beside
 * `transactionNow`'s instant as if they were one reading (D-5).
 */
export async function databaseClock(tx: ExtendedPrismaClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now');
  const now = rows[0]?.now;
  if (!(now instanceof Date)) {
    throw new Error('SELECT clock_timestamp() did not return a timestamp');
  }
  return now;
}

export async function transactionNow(tx: ExtendedPrismaClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now');
  const now = rows[0]?.now;
  if (!(now instanceof Date)) {
    // Unreachable against PostgreSQL, and deliberately loud rather than a silent
    // `new Date()` fallback: falling back to the application clock is the exact defect this
    // function exists to remove.
    throw new Error(
      'SELECT now() did not return a timestamp; refusing to fall back to the application clock',
    );
  }
  return now;
}
