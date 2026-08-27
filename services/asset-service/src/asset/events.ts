import { z } from 'zod';

/**
 * Events published by asset-service.
 *
 * Split across two topics on purpose (docs/04 § 4.1): asset lifecycle on
 * `rasta.asset.v1`, insurance and inspection on `rasta.insurance.v1`. A
 * consumer that only cares about expiring policies should not have to read
 * every location update — and when insurance is eventually extracted into its
 * own service, its topic moves with it rather than having to be untangled.
 */

export const ASSET_EVENTS = {
  ASSET_CREATED: 'ASSET_CREATED',
  ASSET_UPDATED: 'ASSET_UPDATED',
  ASSET_ACTIVATED: 'ASSET_ACTIVATED',
  ASSET_STATUS_CHANGED: 'ASSET_STATUS_CHANGED',
  ASSET_TRANSFERRED: 'ASSET_TRANSFERRED',
  ASSET_DECOMMISSIONED: 'ASSET_DECOMMISSIONED',
  ASSET_LOCATION_RECORDED: 'ASSET_LOCATION_RECORDED',
  ASSET_DOCUMENT_ATTACHED: 'ASSET_DOCUMENT_ATTACHED',
} as const;

export const INSURANCE_EVENTS = {
  INSURANCE_RECORDED: 'INSURANCE_RECORDED',
  INSURANCE_EXPIRING: 'INSURANCE_EXPIRING',
  INSURANCE_EXPIRED: 'INSURANCE_EXPIRED',
  INSPECTION_RECORDED: 'INSPECTION_RECORDED',
  INSPECTION_EXPIRING: 'INSPECTION_EXPIRING',
  INSPECTION_FAILED: 'INSPECTION_FAILED',
} as const;

export type AssetEventName = (typeof ASSET_EVENTS)[keyof typeof ASSET_EVENTS];
export type InsuranceEventName = (typeof INSURANCE_EVENTS)[keyof typeof INSURANCE_EVENTS];

// ---------------------------------------------------------------------------
// Asset payloads
// ---------------------------------------------------------------------------

export const assetCreatedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  name: z.string(),
  type: z.string(),
  assetTag: z.string().nullable(),
  serialNumber: z.string().nullable(),
  status: z.string(),
});

export const assetUpdatedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  /** Field names only — a rename does not need to put the old value on a topic
   *  that every service reads and retains. */
  changedFields: z.array(z.string()),
});

export const assetActivatedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  commissionedAt: z.string(),
});

/**
 * fleet-service consumes this to keep availability accurate: an asset that has
 * gone OUT_OF_SERVICE must stop being offered for assignment immediately.
 */
export const assetStatusChangedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string(),
});

/**
 * A change of owner.
 *
 * Carries both organizations because every consumer holding a local copy has
 * to move the asset between tenants, and knowing only the destination would
 * leave the old owner's cache stale.
 */
export const assetTransferredPayload = z.object({
  assetId: z.string(),
  fromOrganizationId: z.string(),
  toOrganizationId: z.string(),
  reason: z.string(),
  referenceNo: z.string().nullable(),
  transferredAt: z.string(),
});

export const assetDecommissionedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  reason: z.string(),
  decommissionedAt: z.string(),
});

export const assetLocationRecordedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  locationId: z.string(),
  hasCoordinate: z.boolean(),
  source: z.string(),
});

export const assetDocumentAttachedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  documentId: z.string(),
  kind: z.string(),
  expiresAt: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Insurance payloads
// ---------------------------------------------------------------------------

export const insuranceRecordedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  policyId: z.string(),
  insurerName: z.string(),
  coverage: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
});

/**
 * Drives the renewal reminder the product document asks for (ch. 5.12).
 *
 * `daysRemaining` is included so notification-service can pick a template
 * without recomputing a date, and so a "30 days" and a "3 days" reminder read
 * differently to the recipient.
 */
export const insuranceExpiringPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  policyId: z.string(),
  insurerName: z.string(),
  validTo: z.string(),
  daysRemaining: z.number().int(),
});

export const insuranceExpiredPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  policyId: z.string(),
  validTo: z.string(),
});

export const inspectionRecordedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  inspectionId: z.string(),
  certificateNo: z.string(),
  result: z.string(),
  validTo: z.string(),
});

export const inspectionExpiringPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  inspectionId: z.string(),
  validTo: z.string(),
  daysRemaining: z.number().int(),
});

/**
 * A failed inspection is a safety event, not an administrative one: the asset
 * must stop being dispatched. fleet-service and maintenance-service both act
 * on it.
 */
export const inspectionFailedPayload = z.object({
  assetId: z.string(),
  organizationId: z.string(),
  inspectionId: z.string(),
  notes: z.string().nullable(),
});

export const ASSET_EVENT_SCHEMAS = {
  [ASSET_EVENTS.ASSET_CREATED]: assetCreatedPayload,
  [ASSET_EVENTS.ASSET_UPDATED]: assetUpdatedPayload,
  [ASSET_EVENTS.ASSET_ACTIVATED]: assetActivatedPayload,
  [ASSET_EVENTS.ASSET_STATUS_CHANGED]: assetStatusChangedPayload,
  [ASSET_EVENTS.ASSET_TRANSFERRED]: assetTransferredPayload,
  [ASSET_EVENTS.ASSET_DECOMMISSIONED]: assetDecommissionedPayload,
  [ASSET_EVENTS.ASSET_LOCATION_RECORDED]: assetLocationRecordedPayload,
  [ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED]: assetDocumentAttachedPayload,
} as const satisfies Record<AssetEventName, z.ZodTypeAny>;

export const INSURANCE_EVENT_SCHEMAS = {
  [INSURANCE_EVENTS.INSURANCE_RECORDED]: insuranceRecordedPayload,
  [INSURANCE_EVENTS.INSURANCE_EXPIRING]: insuranceExpiringPayload,
  [INSURANCE_EVENTS.INSURANCE_EXPIRED]: insuranceExpiredPayload,
  [INSURANCE_EVENTS.INSPECTION_RECORDED]: inspectionRecordedPayload,
  [INSURANCE_EVENTS.INSPECTION_EXPIRING]: inspectionExpiringPayload,
  [INSURANCE_EVENTS.INSPECTION_FAILED]: inspectionFailedPayload,
} as const satisfies Record<InsuranceEventName, z.ZodTypeAny>;

/** Validates before the payload reaches the outbox, so a malformed event never
 *  enters the log where it would end up in a dead-letter topic for someone to
 *  triage by hand. */
export function validateAssetPayload(eventName: AssetEventName, payload: unknown): unknown {
  return ASSET_EVENT_SCHEMAS[eventName].parse(payload);
}

export function validateInsurancePayload(eventName: InsuranceEventName, payload: unknown): unknown {
  return INSURANCE_EVENT_SCHEMAS[eventName].parse(payload);
}

// ---------------------------------------------------------------------------
// Consumed events — the electronic dossier
// ---------------------------------------------------------------------------

/**
 * Events from other services that become timeline entries.
 *
 * This map is the mechanism behind the product document's promise that "every
 * event recorded in other modules is automatically attached to the machine's
 * file" (ch. 5.4). Adding a new source is a row here plus a projector, never a
 * change to those services.
 *
 * The schemas are deliberately loose — `.passthrough()` with only the fields
 * this service reads. A producer adding a field must not break the dossier,
 * and asset-service has no business asserting the full shape of another
 * service's event.
 */
export const CONSUMED_EVENT_CATEGORY = {
  USAGE_RECORDED: 'USAGE',
  ASSET_ASSIGNED: 'USAGE',
  ASSIGNMENT_ENDED: 'USAGE',
  MAINTENANCE_CREATED: 'MAINTENANCE',
  MAINTENANCE_STARTED: 'MAINTENANCE',
  MAINTENANCE_COMPLETED: 'MAINTENANCE',
  REPAIR_COMPLETED: 'MAINTENANCE',
  BREAKDOWN_REPORTED: 'MAINTENANCE',
  ORDER_COMPLETED: 'COST',
  PROJECT_ASSET_ASSIGNED: 'PROJECT',
  MISSION_STARTED: 'PROJECT',
  MISSION_COMPLETED: 'PROJECT',
} as const;

export type ConsumedEventName = keyof typeof CONSUMED_EVENT_CATEGORY;

/** The minimum any consumed event must carry to be attachable to a dossier. */
export const timelineSourceSchema = z
  .object({
    assetId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
  })
  .passthrough();
