/**
 * Names of the database objects this service's invariants live in.
 *
 * Kept as constants rather than typed out at each use, because the code that
 * translates a constraint violation into a business error matches on these
 * names — and a rename in the migration that is not mirrored here would turn
 * a precise "this driver is already assigned" into a generic conflict, with
 * nothing failing to say so.
 *
 * The indexes themselves are created in the migration, not in schema.prisma:
 * Prisma has no syntax for a partial index, and the invariant docs/05 § 5.5
 * specifies is exactly `UNIQUE (driver_id) WHERE ended_at IS NULL`.
 */

export const ACTIVE_ASSIGNMENT_DRIVER_CONSTRAINT = 'ux_assignment_active_driver';
export const ACTIVE_ASSIGNMENT_ASSET_CONSTRAINT = 'ux_assignment_active_asset';

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
