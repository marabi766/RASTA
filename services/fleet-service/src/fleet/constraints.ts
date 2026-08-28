/**
 * The database objects this service's invariants live in, and how a violation
 * of each one actually reaches the code.
 *
 * The indexes are created in the migration, not in schema.prisma: Prisma has no
 * syntax for a partial index, and the invariant docs/05 § 5.5 specifies is
 * exactly `UNIQUE (driver_id) WHERE ended_at IS NULL`.
 */

export const ACTIVE_ASSIGNMENT_DRIVER_CONSTRAINT = 'ux_assignment_active_driver';
export const ACTIVE_ASSIGNMENT_ASSET_CONSTRAINT = 'ux_assignment_active_asset';

/**
 * Which invariant a unique violation broke.
 *
 * Prisma does **not** report the index name. For a `P2002` it puts the indexed
 * *columns* in `meta.target` — `driver_id`, `asset_id` — and the index name
 * appears nowhere. Matching on the names above therefore never matched, and
 * every genuine race fell through to a generic `ALREADY_EXISTS` instead of the
 * precise "this driver already holds an assignment" a sequential caller gets.
 * The integration suite caught exactly that; the unit tests could not, because
 * only a real PostgreSQL produces the error.
 *
 * Both forms are accepted: the column, which is what Prisma reports today, and
 * the index name, in case a future client version or a raw-SQL path reports
 * that instead. The column is unambiguous here because `driver_id` and
 * `asset_id` each appear in exactly one unique index on this table.
 */
export type ExclusivityConstraint = 'driver' | 'asset' | 'other';

export function identifyExclusivityConstraint(target: string | undefined): ExclusivityConstraint {
  if (!target) return 'other';
  if (target.includes(ACTIVE_ASSIGNMENT_DRIVER_CONSTRAINT) || target.includes('driver_id')) {
    return 'driver';
  }
  if (target.includes(ACTIVE_ASSIGNMENT_ASSET_CONSTRAINT) || target.includes('asset_id')) {
    return 'asset';
  }
  return 'other';
}

/**
 * Asset states in which a machine may be dispatched.
 *
 * Mirrors asset-service's `DISPATCHABLE_STATUSES`, but is deliberately its own
 * list rather than an import: importing across a service boundary is forbidden
 * (AGENTS.md A-02), and the two answer different questions anyway. asset-service
 * asks "is this machine's file complete enough to send out"; fleet asks "is its
 * last reported state one I may attach a driver to".
 *
 * `ASSIGNED` is absent on purpose. A machine already reported as assigned is
 * one the exclusivity index will refuse anyway, and listing it here would let
 * a stale replica look like permission.
 */
export const ACTIVE_ASSET_STATUSES: readonly string[] = ['ACTIVE', 'IDLE'];
