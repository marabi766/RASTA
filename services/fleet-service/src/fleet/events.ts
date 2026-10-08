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
  // A second deliberate addition, alongside DRIVER_STATUS_CHANGED (L3-11):
  // editing a driver's profile is a state change with no event at all before
  // this, not merely one whose payload was too thin.
  DRIVER_UPDATED: 'DRIVER_UPDATED',
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
 * A driver's profile fields changed — licence number, licence class, employee
 * number, or notes.
 *
 * Field names only, never their values (the same rule `ASSET_UPDATED` in
 * asset-service follows): a licence number is exactly the kind of durable,
 * personally identifying fact this module's own header warns against putting
 * on a topic every service reads and retains (docs/07 § 7.3). Before this
 * event existed, `DriverService.update` wrote the row and nothing else —
 * audit-service, whose only input is events, never learned a licence number
 * had changed (AGENTS.md S-06).
 */
export const driverUpdatedPayload = z.object({
  driverId: z.string(),
  organizationId: z.string(),
  changedFields: z.array(z.string()),
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
  [FLEET_EVENTS.DRIVER_UPDATED]: driverUpdatedPayload,
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
  // The only event that ends an insurance lapse (L3-02): its coverage and
  // `validFrom`/`validTo` are stored, and a lapse of the same coverage is
  // answered while that window is in force (dispatch-blocks.ts).
  INSURANCE_RECORDED: 'INSURANCE_RECORDED',
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

/**
 * `ASSET_CREATED`, held to the fields its projection copies (asset-service
 * `assetCreatedPayload` always carries them). One without its status would
 * otherwise be written as `REGISTERED`, a status nobody stated (review #205
 * r1). Still `.passthrough()` for fields added later.
 */
export const assetCreatedSchema = assetSourceSchema.extend({
  name: z.string(),
  type: z.string(),
  assetTag: z.string().nullable(),
  status: z.string().min(1),
});

/**
 * `ASSET_STATUS_CHANGED`, held to the status it changes to (asset-service
 * `assetStatusChangedPayload`). Without `newStatus` the replica would keep the
 * old status and be marked processed — an asset taken OUT_OF_SERVICE could
 * stay dispatchable, with no corrected replay able to fix it (review #205 r1).
 */
export const assetStatusChangedSchema = assetSourceSchema.extend({
  newStatus: z.string().min(1),
});

/** An instant as asset-service writes it (`toISOString()`); an offset is accepted too. */
const isoInstant = z.string().datetime({ offset: true });

/**
 * `INSURANCE_RECORDED`, held to the four fields its projection acts on and to
 * the producer's own rule for them (asset-service `insuranceRecordedPayload`,
 * `CreatePolicyDto`: ISO instants, `validTo` after `validFrom`).
 *
 * This is the only event that ends an insurance lapse, and it does so only
 * from the policy's own window. One without its coverage or policy id, or
 * with dates that do not parse or a window that ends before it starts,
 * answers nothing; acknowledged, it would be marked processed and a corrected
 * replay with the same id would then be ignored. So it is refused before the
 * marker (audit L7-26, review #205 r1) while the lapse stays in force. Still
 * `.passthrough()` for fields added later.
 */
export const insuranceRecordedFields = assetSourceSchema.extend({
  policyId: z.string().min(1),
  coverage: z.string().min(1),
  validFrom: isoInstant,
  validTo: isoInstant,
  /**
   * The asset's ownership generation when the policy was recorded (additive,
   * #240 round 2). Optional: an event that predates it reads as the previous
   * owner's after a transfer, unless its coverage follows the vehicle.
   */
  ownershipGeneration: z.number().int().nonnegative().optional(),
});

/**
 * The window itself: both instants parse and `validTo` is after `validFrom`.
 * An unparseable date fails here as well as in the format check, so the
 * refusal never rests on the format check alone.
 */
export const insuranceRecordedSchema = insuranceRecordedFields.refine(
  (payload) => {
    const from = Date.parse(payload.validFrom);
    const to = Date.parse(payload.validTo);
    return Number.isFinite(from) && Number.isFinite(to) && from < to;
  },
  { path: ['validTo'], message: 'validTo must be an instant after validFrom' },
);

/**
 * `ASSET_TRANSFERRED`, held to more than {@link assetSourceSchema} (review
 * #127 #5).
 *
 * This event moves the replica to a new owner, ends the previous owner's
 * assignments and lifts its transfer fence (ADR-062). One without
 * `toOrganizationId` would keep the old owner in the replica yet still lift
 * the fence, and be marked processed; one without `fromOrganizationId` would
 * leave the fence standing. So every field the handler acts on is required,
 * the two organizations must differ, and the handler checks the envelope
 * agrees (`aggregateId` is the asset, `tenantId` the new owner — what
 * asset-service stamps). Still `.passthrough()` for fields added later.
 */
export const assetTransferredSchema = z
  .object({
    assetId: z.string().min(1),
    fromOrganizationId: z.string().min(1),
    toOrganizationId: z.string().min(1),
    transferredAt: z.string().datetime({ offset: true }),
    // Additive (#240 round 2). The asset's new ownership generation and the
    // coverages that follow the vehicle, computed by asset-service at transfer
    // time. Absent on an older event: the projection then keeps no window.
    ownershipGeneration: z.number().int().nonnegative().optional(),
    retainedCoverages: z.array(z.string().min(1)).optional(),
  })
  .passthrough()
  .refine((payload) => payload.fromOrganizationId !== payload.toOrganizationId, {
    message: 'a transfer moves the asset to another organization',
  });

/** What a consumed event's payload is checked against, and the field names a refusal may repeat (S-09). */
export interface ConsumedPayloadContract {
  readonly schema: z.ZodTypeAny;
  readonly fields: readonly string[];
}

const contract = (object: z.AnyZodObject, schema: z.ZodTypeAny = object) => ({
  schema,
  fields: Object.keys(object.shape),
});

/**
 * Per consumed event, the producer-contract fields its projection uses
 * (review #205 r1). Checked before the processed marker: a known event that
 * fails is dead-lettered as `VALIDATION_FAILED` and a corrected replay with
 * the same id is still applied.
 *
 * The rest need only the machine. `ASSET_TRANSFERRED` is held to
 * {@link assetTransferredSchema} by the handler before this. The safety
 * withdrawals — `INSPECTION_FAILED`, `INSURANCE_EXPIRED` — are deliberately not
 * held to more: refusing one would leave the machine dispatchable until the
 * replay, which is the failure they exist to prevent; a lapse naming no
 * coverage is recorded as `UNKNOWN`, which blocks.
 */
export const CONSUMED_PAYLOADS: Record<ConsumedEventName, ConsumedPayloadContract> = {
  [CONSUMED_EVENTS.ASSET_CREATED]: contract(assetCreatedSchema),
  [CONSUMED_EVENTS.ASSET_UPDATED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.ASSET_ACTIVATED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.ASSET_STATUS_CHANGED]: contract(assetStatusChangedSchema),
  [CONSUMED_EVENTS.ASSET_TRANSFERRED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.ASSET_DECOMMISSIONED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.INSPECTION_FAILED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.INSURANCE_EXPIRED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.INSURANCE_RECORDED]: contract(insuranceRecordedFields, insuranceRecordedSchema),
  [CONSUMED_EVENTS.MAINTENANCE_STARTED]: contract(assetSourceSchema),
  [CONSUMED_EVENTS.MAINTENANCE_COMPLETED]: contract(assetSourceSchema),
};
