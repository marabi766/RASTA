import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * Metrics owned by inventory-service.
 *
 * Only the ones answering a question an operator will actually ask. The platform-wide
 * series — outbox lag, HTTP latency, authorization denials — are defined in
 * `@rasta/observability` and not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a tenant.** No label carries an
 * `organizationId`, a warehouse, a product or a quantity (AGENTS.md S-09). The labels used — a
 * command, an outcome — are fixed, small enumerations.
 */

/**
 * What each command did: `command` is one of `create_warehouse`, `receive`, `adjust`, `reserve`,
 * `release`, `issue`, `create_shipment`, `dispatch_shipment`, `deliver_shipment`; `outcome` one
 * of `applied`, `refused` or `contended` (a stock item or shipment another command held past
 * INVENTORY_LOCK_TIMEOUT_MS — 409 with Retry-After). A steady `contended` is a hot item; a steady
 * `refused` on `reserve` is demand above stock.
 */
export const inventoryCommandsTotal = new Counter({
  name: 'rasta_inventory_commands_total',
  help: 'Inventory commands handled, by command and outcome',
  labelNames: ['service', 'command', 'outcome'] as const,
  registers: [registry],
});

/**
 * Reservations ended because their `expiresAt` passed, by who noticed: `command` (a command
 * that locked the item expired it first) or `sweeper`.
 */
export const inventoryReservationsExpiredTotal = new Counter({
  name: 'rasta_inventory_reservations_expired_total',
  help: 'Reservations expired, by the path that expired them',
  labelNames: ['service', 'path'] as const,
  registers: [registry],
});

/**
 * ACTIVE reservations whose `expiresAt` has passed and that still hold stock. Sampled from the
 * database, never maintained by inc/dec (ADR-050): a value that keeps rising means the sweeper
 * is not keeping up — or not running.
 */
export const inventoryReservationsOverdue = new Gauge({
  name: 'rasta_inventory_reservations_overdue',
  help: 'ACTIVE reservations past their expiresAt, not yet released',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Commands answered from a stored response under their Idempotency-Key: a retry that did
 * nothing a second time. `endpoint` is the route template, a closed set.
 */
export const idempotentReplaysTotal = new Counter({
  name: 'rasta_inventory_idempotent_replays_total',
  help: 'Requests answered from a stored response under their Idempotency-Key',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});
