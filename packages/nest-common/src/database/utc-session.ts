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
 * What identifies the transaction a Prisma operation runs in: the transaction itself for an
 * interactive one, the lock its statements share for a batch (`admitBatched` in the identity
 * service keys on it too); undefined for an autocommit statement. Prisma's private fields, so if
 * an upgrade removes them this refuses: read as "no transaction", a statement of an interactive
 * transaction would move into a batch of its own and silently lose its atomicity.
 */
export function transactionIdentity(params: unknown): object | undefined {
  const internal = (params as { __internalParams?: { transaction?: unknown } }).__internalParams;
  if (internal === undefined) {
    throw new Error('refused: this Prisma version does not say which transaction a query is in');
  }
  const transaction = internal.transaction as { kind?: unknown; lock?: unknown } | undefined;
  if (transaction === undefined) return undefined;
  if (transaction.kind === 'itx') return transaction;
  if (transaction.kind === 'batch' && typeof transaction.lock === 'object' && transaction.lock) {
    return transaction.lock;
  }
  throw new Error('refused: this Prisma version does not say which transaction a query is in');
}

/** Whether an operation is, verbatim, {@link UTC_SESSION_CHECK_SQL}. */
export function isSessionCheck(operation: unknown, args: unknown): boolean {
  return (
    operation === '$queryRawUnsafe' &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === UTC_SESSION_CHECK_SQL
  );
}

/**
 * A statement in a transaction nothing proves began with the check. Being in a transaction is
 * no proof: that transaction may have come from a client without the check (PR #906 r1 F1).
 */
export function uncheckedTransactionRefusal(): Error {
  return new Error('refused: this transaction did not begin with the UTC session check');
}

/**
 * The properties that hand out a client without the check: Prisma's `$parent`, on a client and on
 * a model, and the private fields behind it. The check sits on top of each client's predecessor
 * (see `safe-prisma-client.ts`), so every predecessor is unchecked by construction. Prisma's other
 * private fields (`_engine`, `_requestHandler`) are untyped internals its own methods read through
 * this client, so they stay reachable by a cast; what is typed and public is closed.
 */
const UNCHECKED_PREDECESSORS: ReadonlySet<PropertyKey> = new Set([
  '$parent',
  '_appliedParent',
  '_originalClient',
  '__proto__',
]);

export function refuseUncheckedPredecessor(key: PropertyKey): void {
  if (UNCHECKED_PREDECESSORS.has(key)) {
    throw new Error(
      `refused: ${String(key)} would hand out a client without the UTC session check`,
    );
  }
}
