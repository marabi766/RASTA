import { Injectable } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { decisionInstant } from '../shared/clock';

/**
 * The clock a tender's deadline is judged on (ADR-065 § 2).
 *
 * An abstract class so it is its own injection token. The only implementation in
 * production is the database's: `clock_timestamp()` read **after** the tender row
 * was locked, never the application's clock and never the transaction's start
 * (`now()`), which a long lock wait can leave before the deadline. Tests put an
 * instant in through the module's provider, not through an environment variable
 * (ADR-065 § 2); the database's own trigger still judges against its clock, so a
 * test clock cannot make the database accept what it would refuse.
 */
export abstract class TenderClock {
  /** The instant of the decision, read inside `tx`, after the lock that serialises it. */
  abstract decisionInstant(tx: ExtendedPrismaClient): Promise<Date>;
}

@Injectable()
export class DatabaseTenderClock extends TenderClock {
  decisionInstant(tx: ExtendedPrismaClient): Promise<Date> {
    return decisionInstant(tx);
  }
}

/**
 * Whether `at` is inside the half-open window `[opening, closing)`: a bid arriving
 * at the very instant of `closing` is refused.
 */
export function insideWindow(at: Date, opening: Date, closing: Date): boolean {
  return opening.getTime() <= at.getTime() && at.getTime() < closing.getTime();
}
