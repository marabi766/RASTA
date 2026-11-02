import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Metadata time for commands without a deadline decision (D-5): transaction start, constant
 * across the transaction. It is NOT safe for expiry after lock waits. See databaseClock and
 * CLOCKS.md for the per-command lock boundary.
 */
export async function transactionNow(tx: ExtendedPrismaClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT now() AS now');
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error(
      'SELECT now() did not return a timestamp; refusing to fall back to the application clock',
    );
  }
  return now;
}

/**
 * Sample once AFTER the last stock/reservation lock a deadline decision depends on. Reuse the
 * returned instant for every expiry decision, reservation, balance, movement and event in that
 * command. Reading clock_timestamp separately for each write would let the row and event drift;
 * reading now(), even after locks, would still return the stale transaction start (audit F1).
 * The database is the only clock. A bad reading aborts; there is no application-clock fallback.
 */
export async function databaseClock(tx: ExtendedPrismaClient): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>('SELECT clock_timestamp() AS now');
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error(
      'SELECT clock_timestamp() did not return a timestamp; refusing to fall back to the application clock',
    );
  }
  return now;
}
