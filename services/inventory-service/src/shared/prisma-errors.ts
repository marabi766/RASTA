/**
 * Driver error shapes this service reacts to.
 *
 * Kept as predicates rather than checked inline, because `P2002` appearing in a service file
 * reads as a magic string and because "which constraint was violated" decides which platform
 * error the caller gets — a duplicate idempotency key is a replay, a refused balance is a rule.
 *
 * The balance writes are raw SQL, so most of what this service meets arrives as `P2010` with the
 * PostgreSQL SQLSTATE in `meta.code`; {@link sqlStateOf} reads it whichever way it came.
 */

/** PostgreSQL SQLSTATEs this service names. */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  LOCK_NOT_AVAILABLE: '55P03',
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
} as const;

/** A unique constraint was violated. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002') ||
    sqlStateOf(error) === SQLSTATE.UNIQUE_VIOLATION
  );
}

/** A CHECK constraint refused the row. */
export function isCheckViolation(error: unknown): boolean {
  if (sqlStateOf(error) === SQLSTATE.CHECK_VIOLATION) return true;
  const message = (error as { message?: string } | null)?.message ?? '';
  return (
    typeof error === 'object' && error !== null && message.includes('violates check constraint')
  );
}

/** `lock_timeout` elapsed while waiting for a row another transaction holds. */
export function isLockTimeout(error: unknown): boolean {
  if (sqlStateOf(error) === SQLSTATE.LOCK_NOT_AVAILABLE) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('lock timeout');
}

/**
 * Prisma could not give the work a transaction in time, or ended it past its budget: `P2028`
 * (a transaction that could not start within `maxWait` — the pool is exhausted — or that
 * outlived its `timeout`), and `P2024`, the same exhaustion met by a statement outside a
 * transaction. Contention, never a defect: the caller answers it like a lock timeout.
 */
export function isTransactionUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2028' || code === 'P2024';
}

/**
 * The SQLSTATE of a database error, from a raw query (`P2010`, `meta.code`) or from the
 * driver's own message (`Code: \`23505\``), or `undefined` when there is none.
 */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (typeof meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  return /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
}

/** The constraint a violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return undefined;
  return /constraint "([a-z0-9_]+)"/.exec(message)?.[1];
}
