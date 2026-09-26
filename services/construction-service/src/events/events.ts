import { z } from 'zod';
import { PROJECT_STATES } from '../project/project.state-machine';

/**
 * Events published by construction-service, on `rasta.construction.v1`.
 *
 * `PROJECT_CREATED` comes from the platform catalogue (`docs/04` § 4.12,
 * `docs/events/README.md` § Construction). The other six were added for CON-001
 * and approved by the project manager: every change to a project or a need is a
 * state change audit-service must hear about (AGENTS.md S-06, A-08), and the
 * catalogue had no event for editing, cancelling or the need lifecycle.
 *
 * The payloads are defined here because this service owns them (ADR-032); the
 * only cross-service contract in `packages/contracts` is the audit trail.
 *
 * ## What these payloads never carry
 *
 * **No personal data, no document identifier, no free-text description and no
 * geometry.** An event lives seven days in a log every service can read
 * (`docs/07` § 7.3). The operating area can hold hundreds of vertices, so
 * `PROJECT_CREATED` says only `hasArea`; the scope of work and a need's
 * description are prose somebody wrote for their own organization, not for
 * every consumer on the platform. A consumer that needs either asks the API,
 * under its authorization.
 *
 * The `*_UPDATED` events carry the **names** of the fields that changed, never
 * their values — the rule `ASSET_UPDATED` and `DRIVER_UPDATED` already follow.
 *
 * ## What these payloads never claim
 *
 * Nothing here says a project was approved or may be executed. PR 1 has no
 * approval path; `PROJECT_STATUS_CHANGED` with `to = CANCELLED` is the only
 * status change it can publish.
 */

export const CONSTRUCTION_EVENTS = {
  PROJECT_CREATED: 'PROJECT_CREATED',
  PROJECT_UPDATED: 'PROJECT_UPDATED',
  PROJECT_STATUS_CHANGED: 'PROJECT_STATUS_CHANGED',
  PROJECT_NEED_ADDED: 'PROJECT_NEED_ADDED',
  PROJECT_NEED_UPDATED: 'PROJECT_NEED_UPDATED',
  PROJECT_NEED_SUBMITTED: 'PROJECT_NEED_SUBMITTED',
  PROJECT_NEED_WITHDRAWN: 'PROJECT_NEED_WITHDRAWN',
} as const;

export type ConstructionEventName = (typeof CONSTRUCTION_EVENTS)[keyof typeof CONSTRUCTION_EVENTS];

const identifier = z.string().min(1).max(64);
const isoTimestamp = z.string().datetime();
const amountMinor = z.string().regex(/^\d{1,19}$/);
const projectState = z.enum(PROJECT_STATES);
const statedReason = z.string().min(1).max(500);

/** Field names only; sorted and unique so the payload is stable for one change. */
const changedFields = z
  .array(z.string().min(1).max(64))
  .min(1)
  .refine((fields) => new Set(fields).size === fields.length, 'changedFields must be unique');

export const projectCreatedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    title: z.string().min(1).max(200),
    operationType: z.string().min(1).max(100),
    /** Rial minor units as a string, or null while no estimate was given. */
    estimatedCostMinor: amountMinor.nullable(),
    /** Whether an operating area was recorded. The polygon itself is not carried. */
    hasArea: z.boolean(),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

export const projectUpdatedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    changedFields,
    updatedBy: identifier,
    updatedAt: isoTimestamp,
  })
  .strict();

/**
 * A project changed status by a transition that has no dedicated event.
 *
 * In PR 1 that is only cancellation. `reason` is the caller's stated reason for
 * a cancellation and `null` where a transition carries none.
 */
export const projectStatusChangedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    from: projectState,
    to: projectState,
    reason: statedReason.nullable(),
    changedBy: identifier,
    changedAt: isoTimestamp,
  })
  .strict()
  .refine((value) => value.from !== value.to, 'A status change must change the status');

export const projectNeedAddedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    addedBy: identifier,
    addedAt: isoTimestamp,
  })
  .strict();

export const projectNeedUpdatedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    changedFields,
    updatedBy: identifier,
    updatedAt: isoTimestamp,
  })
  .strict();

export const projectNeedSubmittedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    submittedBy: identifier,
    submittedAt: isoTimestamp,
  })
  .strict();

export const projectNeedWithdrawnPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    reason: statedReason,
    withdrawnBy: identifier,
    withdrawnAt: isoTimestamp,
  })
  .strict();

export const CONSTRUCTION_EVENT_SCHEMAS = {
  PROJECT_CREATED: projectCreatedPayload,
  PROJECT_UPDATED: projectUpdatedPayload,
  PROJECT_STATUS_CHANGED: projectStatusChangedPayload,
  PROJECT_NEED_ADDED: projectNeedAddedPayload,
  PROJECT_NEED_UPDATED: projectNeedUpdatedPayload,
  PROJECT_NEED_SUBMITTED: projectNeedSubmittedPayload,
  PROJECT_NEED_WITHDRAWN: projectNeedWithdrawnPayload,
} as const satisfies Record<ConstructionEventName, z.ZodTypeAny>;

export type ConstructionEventPayload<N extends ConstructionEventName> = z.infer<
  (typeof CONSTRUCTION_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload at publish time, not only in a test (`docs/07` § 7.8).
 *
 * Thrown inside the caller's transaction, so an invalid payload rolls back the
 * state change too rather than committing a fact nobody will hear about.
 */
export function validateConstructionPayload<N extends ConstructionEventName>(
  eventName: N,
  payload: unknown,
): ConstructionEventPayload<N> {
  const schema = CONSTRUCTION_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as ConstructionEventPayload<N>;
}
