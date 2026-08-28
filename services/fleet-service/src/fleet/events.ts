import { z } from 'zod';

/**
 * Events published by fleet-service, on `rasta.fleet.v1`.
 *
 * The names come from the platform catalogue (docs/events/README.md § Fleet)
 * rather than being coined here. Two of them — `ASSET_ASSIGNED` and
 * `USAGE_RECORDED` — read oddly for a fleet service at first: they are named
 * for what happened *to the asset*, because that is the aggregate every
 * consumer cares about. asset-service already projects both into the
 * electronic dossier, and maintenance-service will trigger usage-based service
 * schedules off `USAGE_RECORDED`.
 *
 * One deliberate addition to the catalogue: `DRIVER_STATUS_CHANGED`. Suspending
 * a driver is a material state change that ends their assignment, and without
 * an event it is invisible outside this service's own database — which would
 * put it out of reach of audit-service, whose only input is events
 * (AGENTS.md S-06).
 */

export const FLEET_EVENTS = {
  DRIVER_REGISTERED: 'DRIVER_REGISTERED',
  DRIVER_STATUS_CHANGED: 'DRIVER_STATUS_CHANGED',
  ASSET_ASSIGNED: 'ASSET_ASSIGNED',
  ASSIGNMENT_ENDED: 'ASSIGNMENT_ENDED',
  USAGE_RECORDED: 'USAGE_RECORDED',
  AVAILABILITY_CHANGED: 'AVAILABILITY_CHANGED',
} as const;

export type FleetEventName = (typeof FLEET_EVENTS)[keyof typeof FLEET_EVENTS];

// ---------------------------------------------------------------------------
// Payloads
//
// Every payload carries identifiers, never personal data: an event lives in a
// durable log that every service reads and retains, and a driver's licence
// number sitting there for seven days is a privacy liability with no consumer
// (docs/07 § 7.3).
// ---------------------------------------------------------------------------

export const driverRegisteredPayload = z.object({
  driverId: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  status: z.string(),
});

export const driverStatusChangedPayload = z.object({
  driverId: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string(),
});

/**
 * A driver has taken charge of a machine.
 *
 * asset-service projects this into the dossier and moves the asset to
 * `ASSIGNED` (its `PROJECTIONS` table already expects this event by name).
 * `assetId` is therefore load-bearing, not decorative: the projector attaches
 * the entry by it and skips any event that omits it.
 */
export const assetAssignedPayload = z.object({
  assignmentId: z.string(),
  assetId: z.string(),
  driverId: z.string(),
  organizationId: z.string(),
  startedAt: z.string(),
  purpose: z.string().nullable(),
});

/**
 * The counterpart, releasing the machine.
 *
 * Carries `assetId` even though the catalogue's summary column lists only
 * `assignmentId` and `endedAt`. Without it asset-service cannot attach the
 * entry to anything and would log the event as a producer defect — the
 * projection `ASSIGNMENT_ENDED -> ACTIVE` would silently never fire, leaving
 * every released machine stuck in `ASSIGNED`.
 */
export const assignmentEndedPayload = z.object({
  assignmentId: z.string(),
  assetId: z.string(),
  driverId: z.string(),
  organizationId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  reason: z.string(),
});

/**
 * A period of machine use.
 *
 * The trigger for usage-based maintenance schedules (docs/04 § 4.6), so the
 * payload is self-sufficient for that purpose: a consumer evaluating "service
 * every 250 hours" needs the amount consumed *and* the meter reading, and
 * should not have to call back for either.
 *
 * Quantities cross the wire as strings for the same reason money does
 * (ADR-022): they are NUMERIC in the database, and rendering them through a
 * JSON float would reintroduce exactly the drift the column type prevents.
 */
export const usageRecordedPayload = z.object({
  usageRecordId: z.string(),
  assetId: z.string(),
  organizationId: z.string(),
  driverId: z.string().nullable(),
  assignmentId: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  hours: z.string().nullable(),
  kilometres: z.string().nullable(),
  hourMeter: z.string().nullable(),
  odometer: z.string().nullable(),
  source: z.string(),
});

/**
 * A machine's availability for dispatch has changed.
 *
 * construction-service consumes this for the fleet-versus-outsourcing analysis
 * the product document describes (docs/02 § 2.4-ج): which machines are free,
 * and which are busy elsewhere.
 */
export const availabilityChangedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  available: z.boolean(),
  reason: z.string(),
  from: z.string(),
  to: z.string().nullable(),
});

export const FLEET_EVENT_SCHEMAS = {
  [FLEET_EVENTS.DRIVER_REGISTERED]: driverRegisteredPayload,
  [FLEET_EVENTS.DRIVER_STATUS_CHANGED]: driverStatusChangedPayload,
  [FLEET_EVENTS.ASSET_ASSIGNED]: assetAssignedPayload,
  [FLEET_EVENTS.ASSIGNMENT_ENDED]: assignmentEndedPayload,
  [FLEET_EVENTS.USAGE_RECORDED]: usageRecordedPayload,
  [FLEET_EVENTS.AVAILABILITY_CHANGED]: availabilityChangedPayload,
} as const satisfies Record<FleetEventName, z.ZodTypeAny>;

/**
 * Validates before the payload reaches the outbox.
 *
 * Publish-time validation is what keeps a malformed event out of the log
 * entirely (docs/07 § 7.8). The alternative is discovering the mistake in a
 * consumer's dead-letter topic, by which point it is someone else's incident.
 */
export function validateFleetPayload(eventName: FleetEventName, payload: unknown): unknown {
  return FLEET_EVENT_SCHEMAS[eventName].parse(payload);
}

// ---------------------------------------------------------------------------
// Consumed events
// ---------------------------------------------------------------------------

/**
 * Events from other services that fleet acts on.
 *
 * Two distinct jobs, and the difference matters:
 *
 *   reference replica   ASSET_* keeps `asset_ref` accurate, so "which machines
 *                       are free" is a local query rather than an HTTP call
 *                       per row (docs/03 § 3.6)
 *
 *   safety              INSPECTION_FAILED and INSURANCE_EXPIRED withdraw a
 *                       machine from dispatch immediately. The catalogue is
 *                       explicit that a failed inspection is a safety event,
 *                       not an administrative one, and that fleet must act on
 *                       it without inspecting some other event's `result`
 *                       field (docs/events/README.md § Insurance)
 *
 * The schemas are deliberately loose — `.passthrough()` with only the fields
 * this service reads. A producer adding a field must not break the replica,
 * and fleet-service has no business asserting the full shape of another
 * service's event.
 */
export const CONSUMED_EVENTS = {
  ASSET_CREATED: 'ASSET_CREATED',
  ASSET_UPDATED: 'ASSET_UPDATED',
  ASSET_ACTIVATED: 'ASSET_ACTIVATED',
  ASSET_STATUS_CHANGED: 'ASSET_STATUS_CHANGED',
  ASSET_TRANSFERRED: 'ASSET_TRANSFERRED',
  ASSET_DECOMMISSIONED: 'ASSET_DECOMMISSIONED',
  INSPECTION_FAILED: 'INSPECTION_FAILED',
  INSURANCE_EXPIRED: 'INSURANCE_EXPIRED',
  MAINTENANCE_STARTED: 'MAINTENANCE_STARTED',
  MAINTENANCE_COMPLETED: 'MAINTENANCE_COMPLETED',
} as const;

export type ConsumedEventName = (typeof CONSUMED_EVENTS)[keyof typeof CONSUMED_EVENTS];

/** The minimum any consumed event must carry to be usable here. */
export const assetSourceSchema = z
  .object({
    assetId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
  })
  .passthrough();

export type AssetSourceEvent = z.infer<typeof assetSourceSchema>;
