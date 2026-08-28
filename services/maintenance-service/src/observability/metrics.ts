import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

/**
 * Metrics owned by maintenance-service.
 *
 * Only the ones that answer a question an operator will actually ask. The
 * platform-wide ones — outbox lag, DLQ arrivals, event processing duration,
 * HTTP latency, authorization denials — are already defined in
 * `@rasta/observability` and are not duplicated here.
 *
 * One rule governs every label: **no unbounded cardinality**. Nothing here is
 * labelled by `assetId`, `scheduleId` or `workshopOrganizationId`; a
 * per-machine or per-workshop breakdown belongs in analytics-service, against
 * the database.
 *
 * And one thing is deliberately absent: there is no counter of money. A
 * running total of repair spend across every tenant is a number no one can
 * act on and no one should see — the per-organization figure is a report, and
 * reports come from the database (docs/04 § 4.15).
 */

export const requestsCreatedTotal = new Counter({
  name: 'rasta_maintenance_requests_created_total',
  help: 'Maintenance requests raised, by type',
  labelNames: ['service', 'type'] as const,
  registers: [registry],
});

/**
 * Requests refused because one was already open for the same machine and type.
 *
 * Worth its own series rather than being folded into HTTP 4xx: this is the
 * product document's duplicate-request control firing (docs/17), and a rising
 * rate means people are reporting the same fault repeatedly because nothing
 * visible is happening about the first report.
 */
export const duplicateRequestsTotal = new Counter({
  name: 'rasta_maintenance_duplicate_requests_total',
  help: 'Maintenance requests refused because an open one already exists for the machine',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const requestsCompletedTotal = new Counter({
  name: 'rasta_maintenance_requests_completed_total',
  help: 'Maintenance requests completed',
  labelNames: ['service', 'type'] as const,
  registers: [registry],
});

export const requestsApprovedTotal = new Counter({
  name: 'rasta_maintenance_requests_approved_total',
  help: 'Maintenance requests approved by the owner, the gate settlement waits behind',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const requestsOpenTotal = new Gauge({
  name: 'rasta_maintenance_requests_open',
  help: 'Maintenance requests currently open or in progress',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Requests finished and waiting for someone to approve them.
 *
 * The queue that stalls settlement. It is the figure most likely to grow
 * quietly: the machine is back at work, so nobody chases the paperwork, and
 * the workshop is not paid.
 */
export const requestsAwaitingApproval = new Gauge({
  name: 'rasta_maintenance_requests_awaiting_approval',
  help: 'Completed maintenance requests not yet approved by the owner',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * MAINTENANCE_DUE announcements, by which trigger fired and how late it is.
 *
 * `basis` is `TIME`, `HOURS` or `KILOMETRES` and `state` is `DUE_SOON` or
 * `OVERDUE` — both small closed sets, so cardinality stays bounded. The split
 * is what makes the series worth having: a fleet whose announcements are
 * mostly `OVERDUE` is one where the warning lead is set too short to be
 * useful.
 */
export const dueAnnouncementsTotal = new Counter({
  name: 'rasta_maintenance_due_announcements_total',
  help: 'MAINTENANCE_DUE events published, by trigger and state',
  labelNames: ['service', 'basis', 'state'] as const,
  registers: [registry],
});

export const partsRecordedTotal = new Counter({
  name: 'rasta_maintenance_parts_recorded_total',
  help: 'Parts recorded against repair orders, by where they came from',
  labelNames: ['service', 'source'] as const,
  registers: [registry],
});

/**
 * How long machines are out of service, in hours.
 *
 * A histogram rather than a counter: the average downtime of a fleet is far
 * less useful than knowing that most repairs take a day and a few take three
 * weeks, and only the distribution shows that. Buckets are hours, spanning a
 * same-day fix to a machine gone for a month.
 */
export const downtimeHours = new Histogram({
  name: 'rasta_maintenance_downtime_hours',
  help: 'Hours a machine was out of service for one maintenance request',
  labelNames: ['service', 'type'] as const,
  buckets: [1, 4, 8, 24, 72, 168, 336, 720],
  registers: [registry],
});

/**
 * Usage readings folded into the meter read model.
 *
 * Expected to track fleet-service's own usage counter closely. A persistent
 * gap between the two is the signal that this service is losing the events its
 * schedules depend on — which would show up nowhere else until a machine
 * missed a service.
 */
export const usageReadingsAppliedTotal = new Counter({
  name: 'rasta_maintenance_usage_readings_applied_total',
  help: 'USAGE_RECORDED events folded into the asset usage meter',
  labelNames: ['service'] as const,
  registers: [registry],
});
