/**
 * The session a statement runs in must be in UTC, checked on the backend that
 * runs it (FU-188).
 *
 * Why at all: `timestamp(3)` columns hold UTC wall time, and PostgreSQL converts
 * between them and `timestamptz` in the session's zone. Every clock our raw SQL
 * writes or compares says `AT TIME ZONE 'UTC'` (`pnpm check:utc-clock-sites`), so
 * no known site depends on the zone; this refuses the session for the site nobody
 * knows about. A session that is not in UTC is a broken deployment, not a state to
 * work in.
 *
 * Why not once per connection: the zone is a property of a **server** backend, and
 * behind PgBouncer in transaction pooling (docs/11 § 11.2) each transaction may get a
 * different backend, and whether the `options` pin (`withUtcSession`) arrives depends
 * on the pooler's version and configuration. A check at boot or on connect vouches
 * for one backend, once. The only thing PgBouncer keeps together is a transaction, so
 * the check is a statement **inside the transaction that does the work**: it reads the
 * backend that work runs on.
 *
 * Why it raises instead of returning the zone: in a batch `$transaction` Prisma has
 * already handed over every statement when the first result comes back, so a
 * refusal in JavaScript would be too late. The statement fails, the transaction
 * aborts and nothing after it runs. Plain SQL rather than a function of ours, so it
 * needs no migration and cannot be missing from a database. The refused branch is
 * built from `current_setting` so it cannot be folded while planning.
 *
 * Exact text: `Etc/UTC` is the same clock, but it is not what provisioning sets
 * (`lib/session-timezone.bash`), so it says something unexpected happened.
 *
 * Infrastructure, not business logic (A-03).
 */

import { markRefusal } from '@rasta/config';

const REFUSAL_MARKER = 'session TimeZone is not UTC';

/** One statement: answers 1 on a UTC session, raises on any other. */
export const UTC_SESSION_CHECK_SQL = `SELECT CASE WHEN current_setting('TimeZone') = 'UTC' THEN 1
  ELSE ('${REFUSAL_MARKER}: ' || current_setting('TimeZone'))::int END AS utc`;

/** What a refused session surfaces as: a fixed text, no driver message. */
export class SessionTimeZoneRefusedError extends Error {
  override readonly name = 'SessionTimeZoneRefusedError';

  constructor(readonly setting: string) {
    super(
      `${setting}: refused, this database session is not in UTC; nothing was executed. ` +
        'Check the TimeZone default of the role and the database (docs/11 § 11.2).',
    );
    markRefusal(this, 'session-time-zone');
  }
}

/** Whether a client error is {@link UTC_SESSION_CHECK_SQL} refusing. */
export function isSessionTimeZoneRefusal(error: unknown): boolean {
  try {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return code === 'P2010' && typeof message === 'string' && message.includes(REFUSAL_MARKER);
  } catch {
    return false;
  }
}

/**
 * Model operations that may run outside the check, by name, so an operation Prisma
 * adds later is checked by default. Reading a row does not use the session's zone:
 * Prisma decodes `timestamp` as UTC wall time and `timestamptz` as an instant, and
 * its filters bind UTC values. Everything else, every raw statement included, is
 * checked: a write can fire a trigger, and raw text can do anything.
 */
const ZONE_FREE_MODEL_READS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

export function isZoneFreeOperation(model: unknown, operation: unknown): boolean {
  return typeof model === 'string' && ZONE_FREE_MODEL_READS.has(String(operation));
}

/**
 * The transaction a Prisma operation runs in (`__internalParams.transaction`):
 * absent for an autocommit statement. Prisma's private field, so if an upgrade removes it
 * this refuses: read as "no transaction", a statement of an interactive transaction would
 * move into a batch of its own and silently lose its atomicity.
 */
export function runsInTransaction(params: unknown): boolean {
  const internal = (params as { __internalParams?: { transaction?: unknown } }).__internalParams;
  if (internal === undefined) {
    throw new Error('refused: this Prisma version does not say which transaction a query is in');
  }
  return internal.transaction !== undefined;
}
