import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * Metrics owned by fleet-service.
 *
 * Only the ones that answer a question an operator will actually ask. The
 * platform-wide ones — outbox lag, DLQ arrivals, event processing duration,
 * HTTP latency, authorization denials — are already defined in
 * `@rasta/observability` and are not duplicated here.
 *
 * One rule governs every label: **no unbounded cardinality**. Nothing here is
 * labelled by `assetId` or `driverId`; a per-machine breakdown belongs in
 * analytics-service, against the database.
 */

export const assignmentsCreatedTotal = new Counter({
  name: 'rasta_fleet_assignments_created_total',
  help: 'Driver-to-asset assignments created',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Refused assignments, by the invariant that refused them.
 *
 * Worth its own series rather than being folded into HTTP 4xx: a rising
 * `constraint="asset"` rate means machines are being double-booked, which is
 * an operational problem in the yard, not a bug in the API.
 */
export const assignmentConflictsTotal = new Counter({
  name: 'rasta_fleet_assignment_conflicts_total',
  help: 'Assignments refused because an exclusivity invariant would be violated',
  labelNames: ['service', 'constraint'] as const,
  registers: [registry],
});

export const assignmentsActiveTotal = new Gauge({
  name: 'rasta_fleet_assignments_active',
  help: 'Assignments currently open',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const usageRecordsTotal = new Counter({
  name: 'rasta_fleet_usage_records_total',
  help: 'Usage records accepted, by how the reading arrived',
  labelNames: ['service', 'source'] as const,
  registers: [registry],
});

/**
 * Usage submissions recognised as replays of one already stored.
 *
 * Expected to be non-zero: the field application queues readings offline and
 * resends them. A count of zero over a long window is the suspicious reading —
 * it suggests the deduplication key is not reaching the service at all.
 */
export const usageDuplicatesTotal = new Counter({
  name: 'rasta_fleet_usage_duplicates_total',
  help: 'Usage submissions matched to an existing record by client reference',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Assets the fleet currently considers unavailable, by the reason.
 *
 * The label is the blocker code, which is a small closed set — `ASSET_STATUS`,
 * `IN_MAINTENANCE`, `DISPATCH_BLOCKED`, `ACTIVE_ASSIGNMENT`,
 * `DECLARED_UNAVAILABLE` — so cardinality stays bounded.
 */
export const assetsUnavailableTotal = new Gauge({
  name: 'rasta_fleet_assets_unavailable',
  help: 'Assets not dispatchable, by blocking reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});
