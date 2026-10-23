import { RastaError } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The database's clock as it reads now — `clock_timestamp()`, never `now()`,
 * which is when the transaction began and can lie before a lock wait.
 *
 * Read after a lock is taken, it orders the instants written under that lock
 * as the lock ordered the writes, whichever host each came from: one clock,
 * read once the decision is made. The participation and recognition windows
 * are taken by it, and so are a transaction's lifecycle instants (docs/23
 * D-060).
 */
export async function databaseNow(tx: ExtendedPrismaClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!row) throw RastaError.internal('The database returned no clock reading');
  return row.now;
}
