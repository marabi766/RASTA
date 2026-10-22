/**
 * Driver error shapes this service reacts to.
 *
 * Kept as predicates rather than checked inline, because `P2002` appearing in
 * a service file reads as a magic string and because "which constraint was
 * violated" decides which platform error the caller gets — a duplicate
 * idempotency key is a replay, a duplicate open dispute is a business rule.
 */

/** A unique constraint was violated. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

/** A CHECK constraint refused the row. */
export function isCheckViolation(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message ?? '';
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: string }).code === 'P2010' || (error as { code?: string }).code === 'P2000'
      ? true
      : message.includes('violates check constraint'))
  );
}

/**
 * A trigger's own refusal, `RAISE EXCEPTION '<guard>: …' USING ERRCODE = 'check_violation'`.
 *
 * Prisma reports one from a model query as an unknown request error, with no code: the SQLSTATE
 * and the message are only in its text (`PostgresError { code: "23514", message: "<guard>: …" }`).
 * Both are matched — the check_violation and the guard's name at the head of the message — so
 * another guard's refusal, a CHECK constraint, or any other 23514 is not this one.
 */
export function isGuardRefusal(error: unknown, guard: string): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes(`code: "23514", message: "${guard}: `);
}

/** The constraint a violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  const meta = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (typeof meta === 'string') return meta;
  if (Array.isArray(meta)) return meta.join(',');
  return undefined;
}
