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

/** A unique index, as Prisma reports its violation: the model and the columns of its key. */
export interface UniqueIndex {
  /** The index's name in the migration, e.g. `ux_rfq_aggregation`. */
  readonly name: string;
  /** The Prisma model of its table, e.g. `Rfq`. */
  readonly model: string;
  /** The columns of its key, in the database's names. */
  readonly columns: readonly string[];
}

/**
 * A unique violation of `index` and of no other.
 *
 * Prisma 6 names the violated index by its model and its key's columns (`meta.modelName`,
 * `meta.target: ['organization_id', 'aggregation_id']`), and on some paths by the index's name
 * (`meta.target: 'ux_…'`); both are matched. A P2002 of another index of the same table, of
 * another table, or one without metadata is not this one — it stays the failure it is.
 */
export function isUniqueViolationOf(error: unknown, index: UniqueIndex): boolean {
  if (!isUniqueViolation(error)) return false;
  const meta = (error as { meta?: { modelName?: unknown; target?: unknown } }).meta;
  if (meta?.modelName !== index.model) return false;
  const target = meta.target;
  if (typeof target === 'string') return target === index.name;
  if (!Array.isArray(target) || target.length !== index.columns.length) return false;
  const named = new Set(target);
  return index.columns.every((column) => named.has(column));
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
