import { Injectable } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The one clock a decision of this service reads (ADR-070 § 2, ADR-065 § 2): the database's,
 * **after** the row lock the decision is made under — never Node's `new Date()`.
 *
 * Whether a demand joins a window is a comparison with the window's `closes_at`, which the
 * database stored and which its triggers compare too (`ck_demand_request_joins_open_window`). If
 * the instant came from another clock, a legitimate join could violate the trigger and a late one
 * pass it. `clock_timestamp()` rather than `now()`: `now()` is the transaction's start, and a
 * demand that waited on the window's lock past its end must see that it did — the instant is read
 * once the lock is held, and reused for every row and event of the command (D-5).
 *
 * Rounded to the millisecond in SQL (`::timestamptz(3)`), the precision every instant column
 * keeps (D-048): the value compared in TypeScript, stored on the row and published on the event
 * is then one value, never a microsecond reading against its own rounding.
 *
 * An injectable class so the boundary tests can stand at `closes_at − 1 ms` and at `closes_at`
 * exactly, without sleeping (ADR-070 Compliance).
 */
@Injectable()
export class DatabaseClock {
  async now(tx: ExtendedPrismaClient): Promise<Date> {
    const rows = await tx.$queryRawUnsafe<{ now: Date }[]>(
      'SELECT clock_timestamp()::timestamptz(3) AS now',
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      // Unreachable against PostgreSQL, and deliberately loud rather than a silent
      // `new Date()` fallback: falling back to the application clock is the exact defect this
      // class exists to remove.
      throw new Error(
        'SELECT clock_timestamp() did not return a timestamp; refusing to fall back to the application clock',
      );
    }
    return now;
  }
}
