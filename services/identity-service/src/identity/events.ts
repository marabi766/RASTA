import { z } from 'zod';

/**
 * Events published by identity-service.
 *
 * Payloads carry identifiers and decisions, never credentials and never more
 * personal data than a consumer needs. An event lives in the log for as long
 * as the topic retains it and is copied into every consumer's database, so a
 * field added carelessly here is a privacy liability everywhere.
 *
 * A consumer needing a person's full profile calls the API for it, and that
 * call is authorized and audited. Reading it off an event is neither.
 */

export const IDENTITY_EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  USER_ACTIVATED: 'USER_ACTIVATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  MEMBERSHIP_CREATED: 'MEMBERSHIP_CREATED',
  MEMBERSHIP_REVOKED: 'MEMBERSHIP_REVOKED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  ROLE_REVOKED: 'ROLE_REVOKED',
  REGISTRATION_SUBMITTED: 'REGISTRATION_SUBMITTED',
  REGISTRATION_APPROVED: 'REGISTRATION_APPROVED',
  REGISTRATION_REJECTED: 'REGISTRATION_REJECTED',
} as const;

export type IdentityEventName = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];

export const userRegisteredPayload = z.object({
  userId: z.string(),
  username: z.string(),
  requestedOrganizationId: z.string(),
  requestedRoles: z.array(z.string()),
});

export const userActivatedPayload = z.object({
  userId: z.string(),
  organizationId: z.string(),
  roles: z.array(z.string()),
});

export const userUpdatedPayload = z.object({
  userId: z.string(),
  /** Field names only. Values would put personal data on the wire. */
  changedFields: z.array(z.string()),
});

export const userStatusChangedPayload = z.object({
  userId: z.string(),
  previousStatus: z.string(),
  newStatus: z.string(),
  reason: z.string().optional(),
});

export const membershipCreatedPayload = z.object({
  membershipId: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  roles: z.array(z.string()),
});

export const membershipRevokedPayload = z.object({
  membershipId: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  reason: z.string(),
});

/**
 * Role changes.
 *
 * The gateway consumes these to invalidate its cached permissions. Without
 * that, a revoked role keeps working until the cache TTL expires — the exact
 * window during which a suspended user can still act.
 */
export const roleChangedPayload = z.object({
  membershipId: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  previousRoles: z.array(z.string()),
  newRoles: z.array(z.string()),
  reason: z.string().optional(),
});

export const registrationSubmittedPayload = z.object({
  registrationId: z.string(),
  userId: z.string(),
  requestedOrganizationId: z.string(),
  requestedRoles: z.array(z.string()),
});

export const registrationReviewedPayload = z.object({
  registrationId: z.string(),
  userId: z.string(),
  requestedOrganizationId: z.string(),
  outcome: z.enum(['APPROVED', 'REJECTED']),
  reviewedBy: z.string(),
  grantedRoles: z.array(z.string()).optional(),
  rejectionReason: z.string().optional(),
});

/** Payload schema per event, used to validate on publish and on consume. */
export const IDENTITY_EVENT_SCHEMAS = {
  [IDENTITY_EVENTS.USER_REGISTERED]: userRegisteredPayload,
  [IDENTITY_EVENTS.USER_ACTIVATED]: userActivatedPayload,
  [IDENTITY_EVENTS.USER_UPDATED]: userUpdatedPayload,
  [IDENTITY_EVENTS.USER_SUSPENDED]: userStatusChangedPayload,
  [IDENTITY_EVENTS.USER_DEACTIVATED]: userStatusChangedPayload,
  [IDENTITY_EVENTS.MEMBERSHIP_CREATED]: membershipCreatedPayload,
  [IDENTITY_EVENTS.MEMBERSHIP_REVOKED]: membershipRevokedPayload,
  [IDENTITY_EVENTS.ROLE_ASSIGNED]: roleChangedPayload,
  [IDENTITY_EVENTS.ROLE_REVOKED]: roleChangedPayload,
  [IDENTITY_EVENTS.REGISTRATION_SUBMITTED]: registrationSubmittedPayload,
  [IDENTITY_EVENTS.REGISTRATION_APPROVED]: registrationReviewedPayload,
  [IDENTITY_EVENTS.REGISTRATION_REJECTED]: registrationReviewedPayload,
} as const satisfies Record<IdentityEventName, z.ZodTypeAny>;

/**
 * Validates a payload before it reaches the outbox.
 *
 * Checking at publish time keeps a malformed event out of the log entirely.
 * Once it is in the log it is in every consumer's retry loop and, eventually,
 * in a dead-letter topic somebody has to triage by hand.
 */
export function validateIdentityPayload(eventName: IdentityEventName, payload: unknown): unknown {
  return IDENTITY_EVENT_SCHEMAS[eventName].parse(payload);
}
