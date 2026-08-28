import { z } from 'zod';

/**
 * Events published by maintenance-service, on `rasta.maintenance.v1`.
 *
 * The names come from the platform catalogue (docs/events/README.md §
 * Maintenance) rather than being coined here. Two consumers already exist and
 * were written before this service did, which makes their expectations part of
 * the contract rather than a nicety:
 *
 *   asset-service   projects MAINTENANCE_CREATED, MAINTENANCE_STARTED,
 *                   REPAIR_COMPLETED and MAINTENANCE_COMPLETED into the
 *                   electronic dossier, and moves the machine to
 *                   IN_MAINTENANCE and back. Its projector attaches an entry
 *                   by `assetId` and *silently skips* any event without one,
 *                   and reads a cost from `totalCostMinor` as a string.
 *   fleet-service   sets `asset_ref.inMaintenance` from MAINTENANCE_STARTED
 *                   and clears it — along with the dispatch block — on
 *                   MAINTENANCE_COMPLETED.
 *
 * So `assetId` is load-bearing on every event below, not decorative. Omitting
 * it would leave a machine stuck in IN_MAINTENANCE with nothing in its file to
 * explain why, and nothing would report an error: the projector would log a
 * producer defect and move on. fleet-service learned this the hard way with
 * `ASSIGNMENT_ENDED`, and the contract test in `events.spec.ts` locks it here.
 *
 * One deliberate addition to the catalogue: `MAINTENANCE_CANCELLED`. An
 * abandoned request whose creation was already announced leaves every consumer
 * believing the work is still outstanding, and audit-service — whose only
 * input is events — would never learn it was dropped (AGENTS.md S-06). The
 * same reasoning fleet-service used for `DRIVER_STATUS_CHANGED`.
 *
 * ## Money on these events
 *
 * Costs cross the wire as `totalCostMinor`: a **string, in minor units**,
 * beside a separate `currency` field. That is flatter than the catalogue's
 * general `{ amountMinor, currency }` shape, and the deviation is deliberate —
 * asset-service's timeline projector already reads a flat `totalCostMinor`
 * string, and it was written before this service existed. Publishing the
 * nested shape would mean the dossier silently recorded no cost for any
 * repair. Two representations of one amount would be worse still. The
 * catalogue records the deviation.
 */

export const MAINTENANCE_EVENTS = {
  MAINTENANCE_DUE: 'MAINTENANCE_DUE',
  BREAKDOWN_REPORTED: 'BREAKDOWN_REPORTED',
  MAINTENANCE_CREATED: 'MAINTENANCE_CREATED',
  WORKSHOP_ASSIGNED: 'WORKSHOP_ASSIGNED',
  MAINTENANCE_STARTED: 'MAINTENANCE_STARTED',
  REPAIR_COMPLETED: 'REPAIR_COMPLETED',
  MAINTENANCE_COMPLETED: 'MAINTENANCE_COMPLETED',
  MAINTENANCE_APPROVED: 'MAINTENANCE_APPROVED',
  MAINTENANCE_CANCELLED: 'MAINTENANCE_CANCELLED',
} as const;

export type MaintenanceEventName = (typeof MAINTENANCE_EVENTS)[keyof typeof MAINTENANCE_EVENTS];

// ---------------------------------------------------------------------------
// Payloads
//
// Every payload carries identifiers, never personal data: an event lives in a
// durable log that every service reads and retains, and a technician's name
// sitting there for seven days is a privacy liability with no consumer
// (docs/07 § 7.3). That is why `MAINTENANCE_APPROVED` carries a cost breakdown
// by category and not the parts list.
// ---------------------------------------------------------------------------

/** A non-negative integer amount in minor units, as a string (ADR-022). */
const amountMinor = z.string().regex(/^\d{1,30}$/);

/**
 * A schedule has reached — or passed — its due point.
 *
 * notification-service is the intended consumer ("هشدار سررسید", docs/17), and
 * fleet-service can use it to plan around a machine that is about to go in.
 *
 * `dueBy` is nullable, and that is honest rather than sloppy: a usage-based
 * schedule comes due at a *meter reading*, not at a date. Which trigger fired
 * is in `basis`, and the reading it fired at is in `dueAtMeter`.
 */
export const maintenanceDuePayload = z.object({
  scheduleId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  title: z.string(),
  /** `TIME`, `HOURS` or `KILOMETRES` — the trigger that came due first. */
  basis: z.string(),
  /** `DUE_SOON` while inside the warning lead, `OVERDUE` once past. */
  state: z.string(),
  /** The calendar date it is due by, for a time trigger. Null otherwise. */
  dueBy: z.string().nullable(),
  /** The meter reading it is due at, for a usage trigger. Null otherwise. */
  dueAtMeter: z.string().nullable(),
});

/**
 * A machine has failed.
 *
 * Published alongside `MAINTENANCE_CREATED` for a corrective request, not
 * instead of it: the two say different things. One is "something broke", which
 * notification-service acts on immediately; the other is "a piece of work now
 * exists", which the dossier records.
 */
export const breakdownReportedPayload = z.object({
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  severity: z.string(),
  title: z.string(),
  reportedAt: z.string(),
});

/** A piece of maintenance work now exists for this machine. */
export const maintenanceCreatedPayload = z.object({
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  type: z.string(),
  title: z.string(),
  scheduleId: z.string().nullable(),
  dueDate: z.string().nullable(),
  reportedAt: z.string(),
});

/**
 * The work has been referred to a workshop.
 *
 * supplier-service will use it to put the job in that workshop's queue, and
 * notification-service to tell them. Carries `assetId` even though no consumer
 * needs it today, because every event on this topic is partitioned by asset
 * and a payload that cannot name its own partition key is a trap for the next
 * projector.
 */
export const workshopAssignedPayload = z.object({
  requestId: z.string(),
  repairOrderId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  workshopOrganizationId: z.string(),
  assignedAt: z.string(),
});

/**
 * The machine has gone into the workshop.
 *
 * The event that withdraws it from dispatch: asset-service moves it to
 * `IN_MAINTENANCE` and fleet-service sets `asset_ref.inMaintenance`. Neither
 * is told to do so by this service — they decide, from the fact that it
 * happened (ADR-026).
 */
export const maintenanceStartedPayload = z.object({
  requestId: z.string(),
  repairOrderId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  startedAt: z.string(),
  workshopOrganizationId: z.string(),
});

/** One workshop has finished its part, with what it cost. */
export const repairCompletedPayload = z.object({
  repairOrderId: z.string(),
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  workshopOrganizationId: z.string(),
  completedAt: z.string(),
  totalCostMinor: amountMinor,
  currency: z.string(),
});

/**
 * The machine is back in service.
 *
 * Returns it to `ACTIVE` in asset-service and clears both `inMaintenance` and
 * the dispatch block in fleet-service. `totalCostMinor` lands in the dossier
 * as the cost of this repair.
 */
export const maintenanceCompletedPayload = z.object({
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  type: z.string(),
  scheduleId: z.string().nullable(),
  completedAt: z.string(),
  /** How long the machine was unusable, distinct from how long work took. */
  downtimeMinutes: z.number().nullable(),
  totalCostMinor: amountMinor,
  currency: z.string(),
});

/**
 * The owner has approved the work and its cost.
 *
 * The product document's mandatory control: settlement is impossible without
 * it (docs/17, ADR-028). economic-service is the consumer that matters, and
 * the payload is shaped for it — an amount it can post, a breakdown it can
 * audit, and the counterparty it would pay. What it does *not* carry is any
 * hint of how to split, charge or settle that amount: none of those rules
 * belong to this service, and several of them are still open questions
 * (docs/24 Q-08).
 */
export const maintenanceApprovedPayload = z.object({
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  workshopOrganizationId: z.string().nullable(),
  totalCostMinor: amountMinor,
  currency: z.string(),
  /** Per-category totals, so a settlement can be reconciled line by line. */
  costBreakdown: z.array(z.object({ category: z.string(), amountMinor, currency: z.string() })),
});

/** The work was abandoned. Not in the catalogue as published; see above. */
export const maintenanceCancelledPayload = z.object({
  requestId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  cancelledAt: z.string(),
  reason: z.string(),
  /** The status it was cancelled from — an OPEN request and one already in a
   *  workshop are different operational facts. */
  previousStatus: z.string(),
});

export const MAINTENANCE_EVENT_SCHEMAS = {
  [MAINTENANCE_EVENTS.MAINTENANCE_DUE]: maintenanceDuePayload,
  [MAINTENANCE_EVENTS.BREAKDOWN_REPORTED]: breakdownReportedPayload,
  [MAINTENANCE_EVENTS.MAINTENANCE_CREATED]: maintenanceCreatedPayload,
  [MAINTENANCE_EVENTS.WORKSHOP_ASSIGNED]: workshopAssignedPayload,
  [MAINTENANCE_EVENTS.MAINTENANCE_STARTED]: maintenanceStartedPayload,
  [MAINTENANCE_EVENTS.REPAIR_COMPLETED]: repairCompletedPayload,
  [MAINTENANCE_EVENTS.MAINTENANCE_COMPLETED]: maintenanceCompletedPayload,
  [MAINTENANCE_EVENTS.MAINTENANCE_APPROVED]: maintenanceApprovedPayload,
  [MAINTENANCE_EVENTS.MAINTENANCE_CANCELLED]: maintenanceCancelledPayload,
} as const satisfies Record<MaintenanceEventName, z.ZodTypeAny>;

/**
 * Validates before the payload reaches the outbox.
 *
 * Publish-time validation is what keeps a malformed event out of the log
 * entirely (docs/07 § 7.8). The alternative is discovering the mistake in a
 * consumer's dead-letter topic, by which point it is someone else's incident.
 */
export function validateMaintenancePayload(
  eventName: MaintenanceEventName,
  payload: unknown,
): unknown {
  return MAINTENANCE_EVENT_SCHEMAS[eventName].parse(payload);
}

// ---------------------------------------------------------------------------
// Consumed events
// ---------------------------------------------------------------------------

/**
 * Events from other services that maintenance acts on.
 *
 * Two jobs, and they fail differently, which is why they are two consumers
 * with two groups rather than one:
 *
 *   **usage**     `USAGE_RECORDED` from fleet-service is the trigger for
 *                 usage-based service schedules — the platform's single
 *                 largest reason for this service to exist (docs/04 § 4.6).
 *                 Losing one understates a machine's hours and defers a
 *                 service that is actually due.
 *
 *   **replica**   `ASSET_*` keeps `asset_ref` accurate, so a request can be
 *                 refused locally for a machine that is not this tenant's or
 *                 has been decommissioned. Losing one means a slightly stale
 *                 listing.
 *
 * Note what is *not* consumed, and why:
 *
 *   `ASSET_UPDATED`     carries only the *names* of changed fields, never
 *                       their values (docs/events/README.md § Asset), so there
 *                       is nothing here to apply. fleet-service touches its
 *                       replica's `syncedAt` on it; this service has no use
 *                       for that, and consuming an event to do nothing is how
 *                       a subscription list stops describing anything.
 *   `PAYMENT_COMPLETED` docs/04 § 4.7 lists it, for closing the settlement
 *                       cycle. economic-service does not exist, so what
 *                       "closing" means is undefined — and inventing a
 *                       post-approval status would invent the financial
 *                       process this service is explicitly not allowed to own
 *                       (ADR-028). Deferred, deliberately, not overlooked.
 *
 * The schemas are deliberately loose — `.passthrough()` with only the fields
 * this service reads. A producer adding a field must not break the replica,
 * and maintenance-service has no business asserting the full shape of another
 * service's event.
 */
export const CONSUMED_EVENTS = {
  USAGE_RECORDED: 'USAGE_RECORDED',
  ASSET_CREATED: 'ASSET_CREATED',
  ASSET_ACTIVATED: 'ASSET_ACTIVATED',
  ASSET_STATUS_CHANGED: 'ASSET_STATUS_CHANGED',
  ASSET_TRANSFERRED: 'ASSET_TRANSFERRED',
  ASSET_DECOMMISSIONED: 'ASSET_DECOMMISSIONED',
} as const;

export type ConsumedEventName = (typeof CONSUMED_EVENTS)[keyof typeof CONSUMED_EVENTS];

/** The minimum any consumed asset event must carry to be usable here. */
export const assetSourceSchema = z
  .object({
    assetId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * The shape of `USAGE_RECORDED` this service depends on.
 *
 * Quantities arrive as strings because they are NUMERIC at the source and a
 * JSON float would reintroduce exactly the drift the column type prevents —
 * fleet-service's own event contract says so, and this is the consumer that
 * drift would harm: an hour lost per reading is a service missed after two
 * hundred of them.
 *
 * Every quantity is optional. fleet-service requires *at least one* of hours
 * or kilometres and permits both meters to be absent, so a reading with only
 * kilometres is valid input here and must not be dead-lettered.
 */
export const usageRecordedSchema = z
  .object({
    usageRecordId: z.string().min(1),
    assetId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    periodEnd: z.string().optional(),
    hours: z.string().nullable().optional(),
    kilometres: z.string().nullable().optional(),
    hourMeter: z.string().nullable().optional(),
    odometer: z.string().nullable().optional(),
  })
  .passthrough();

export type UsageRecordedEvent = z.infer<typeof usageRecordedSchema>;
