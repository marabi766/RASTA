import { z } from 'zod';

/**
 * Events published by organization-service.
 *
 * Nearly every other service consumes these to maintain its local
 * `organization_ref` replica (docs/03 § 3.6), so the payloads carry the small
 * set of facts a consumer needs to render a name and decide whether an
 * organization is still active — and nothing more.
 */

export const ORGANIZATION_EVENTS = {
  ORGANIZATION_CREATED: 'ORGANIZATION_CREATED',
  ORGANIZATION_UPDATED: 'ORGANIZATION_UPDATED',
  ORGANIZATION_MOVED: 'ORGANIZATION_MOVED',
  ORGANIZATION_STATUS_CHANGED: 'ORGANIZATION_STATUS_CHANGED',
  ORGANIZATION_POLICY_CHANGED: 'ORGANIZATION_POLICY_CHANGED',
  ORGANIZATION_LOCATION_CHANGED: 'ORGANIZATION_LOCATION_CHANGED',
} as const;

export type OrganizationEventName = (typeof ORGANIZATION_EVENTS)[keyof typeof ORGANIZATION_EVENTS];

export const organizationCreatedPayload = z.object({
  organizationId: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  parentId: z.string().nullable(),
  path: z.string().nullable(),
  depth: z.number().int(),
});

export const organizationUpdatedPayload = z.object({
  organizationId: z.string(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  changedFields: z.array(z.string()),
});

/**
 * A move rewrites the path of every descendant, so consumers holding a cached
 * subtree must rebuild it. `affectedCount` tells them how big the change was
 * without forcing them to walk the tree to find out.
 */
export const organizationMovedPayload = z.object({
  organizationId: z.string(),
  previousParentId: z.string().nullable(),
  newParentId: z.string().nullable(),
  previousPath: z.string().nullable(),
  newPath: z.string().nullable(),
  affectedCount: z.number().int(),
  reason: z.string(),
});

/**
 * Status changes matter more than they look. A SUSPENDED organization must
 * stop transacting immediately, so marketplace, procurement and economic all
 * act on this.
 */
export const organizationStatusChangedPayload = z.object({
  organizationId: z.string(),
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string(),
  /** Descendants also affected, since status cascades down the tree. */
  affectedIds: z.array(z.string()),
});

/**
 * Governance configuration changed.
 *
 * `construction-service` consumes this to reload approval policy. The value is
 * included because a policy is configuration, not personal data, and consumers
 * would otherwise call straight back for it.
 */
export const organizationPolicyChangedPayload = z.object({
  organizationId: z.string(),
  key: z.string(),
  value: z.unknown(),
  inheritable: z.boolean(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  changedBy: z.string(),
});

export const organizationLocationChangedPayload = z.object({
  organizationId: z.string(),
  locationId: z.string(),
  kind: z.string(),
  hasCoordinate: z.boolean(),
});

export const ORGANIZATION_EVENT_SCHEMAS = {
  [ORGANIZATION_EVENTS.ORGANIZATION_CREATED]: organizationCreatedPayload,
  [ORGANIZATION_EVENTS.ORGANIZATION_UPDATED]: organizationUpdatedPayload,
  [ORGANIZATION_EVENTS.ORGANIZATION_MOVED]: organizationMovedPayload,
  [ORGANIZATION_EVENTS.ORGANIZATION_STATUS_CHANGED]: organizationStatusChangedPayload,
  [ORGANIZATION_EVENTS.ORGANIZATION_POLICY_CHANGED]: organizationPolicyChangedPayload,
  [ORGANIZATION_EVENTS.ORGANIZATION_LOCATION_CHANGED]: organizationLocationChangedPayload,
} as const satisfies Record<OrganizationEventName, z.ZodTypeAny>;

/**
 * Validates a payload before it reaches the outbox.
 *
 * Failing here keeps a malformed event out of the log entirely. Once it is in
 * the log it is in every consumer's retry loop and eventually in a dead-letter
 * topic somebody has to triage by hand.
 */
export function validateOrganizationPayload(
  eventName: OrganizationEventName,
  payload: unknown,
): unknown {
  return ORGANIZATION_EVENT_SCHEMAS[eventName].parse(payload);
}
