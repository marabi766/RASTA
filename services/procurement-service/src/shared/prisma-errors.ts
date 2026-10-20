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

/** The constraint a violation names, when the driver reports one. */
export function violatedConstraint(error: unknown): string | undefined {
  const meta = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (typeof meta === 'string') return meta;
  if (Array.isArray(meta)) return meta.join(',');
  return undefined;
}
