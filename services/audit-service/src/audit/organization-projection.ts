import { z } from 'zod';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';

/**
 * The consumer-side contract for the three organization events that carry
 * hierarchy facts, and the projection instruction each one produces.
 *
 * ## Why this is a local schema and not an import
 *
 * organization-service declares these payloads in
 * `services/organization-service/src/organization/events.ts`. AGENTS.md A-02
 * forbids importing from another service's `src/**`, and moving that file into
 * `packages/contracts` was considered and rejected for this step: the producer
 * file also carries `validateOrganizationPayload`, the outbox-side rule that a
 * payload is checked *before* it is enqueued, and three payloads this service
 * has no interest in. Lifting the whole thing would move a producer's
 * enforcement into a shared package, and lifting half of it would leave two
 * declarations of the same event in the repository — which is the drift a
 * shared contract exists to prevent.
 *
 * So this file states, narrowly and in one place, the fields **this consumer
 * depends on**, and states them as a schema rather than as a cast. A producer
 * that drops `parentId` from `ORGANIZATION_CREATED` does not silently produce
 * an `undefined` parent here; it produces a validation failure, which is a
 * dead-lettered message and an alert (ADR-053 § 9) rather than an organization
 * that quietly becomes a hierarchy root.
 *
 * ## Deliberately tolerant in one direction only
 *
 * Each schema is `.passthrough()`-shaped by omission: unknown *extra* fields
 * are accepted, because a producer adding a field must not dead-letter this
 * consumer. Missing or wrongly-typed fields that this service reads are
 * refused. Tolerant of growth, strict about what it uses.
 */

/** The topic these events arrive on. Delivery metadata, never the envelope. */
export const ORGANIZATION_TOPIC = 'rasta.organization.v1';

export const ORGANIZATION_PROJECTION_EVENTS = {
  CREATED: 'ORGANIZATION_CREATED',
  MOVED: 'ORGANIZATION_MOVED',
  STATUS_CHANGED: 'ORGANIZATION_STATUS_CHANGED',
} as const;

/**
 * Bounds mirrored from the migration, so an oversized upstream value is cut
 * here rather than raising `22001` and turning one long path into a
 * dead-lettered event.
 *
 * **Only diagnostics are bounded.** `hierarchyPath` is cut because no decision
 * reads it. Every **identifier** — `organizationId`, `parentId`, `newParentId`
 * and each cascade member — is refused instead: a truncated identifier is a
 * *different* organization, and one that happens to exist would silently move
 * an organization into somebody else's subtree. `status` is bounded because it
 * is checked against an allow-list (`ORGANIZATION_DOMAIN_STATUSES`) rather than
 * compared for inequality, so a cut value stops matching and denies.
 */
const LIMITS = {
  organizationId: 128,
  hierarchyPath: 2048,
  status: 64,
} as const;

const identifier = z.string().trim().min(1).max(LIMITS.organizationId);

/**
 * A parent link: the same bounded identifier contract as `organizationId`, or
 * genuinely absent.
 *
 * `parentId` and `newParentId` are **identifiers**, not descriptions, and they
 * decide who reaches whom: `isWithinProjectedSubtree` walks this column upwards
 * and every step it takes is an authorization step. So they are held to the
 * identifier contract and never bounded — truncating `ORG-UNION-A-LONG…` to 128
 * characters could produce `ORG-UNION-A`, an identifier that exists and belongs
 * to somebody else, silently re-parenting an organization into another union's
 * subtree. An identifier that does not fit is refused, which dead-letters one
 * event; a truncated one is a cross-tenant read nobody notices.
 *
 * A blank string is read as "no parent" rather than refused. That is the
 * narrowing direction: a parentless row is a root, and a root is inside nobody
 * else's subtree.
 */
const parentIdentifier = z
  .union([z.string(), z.null()])
  .transform((value) => {
    const trimmed = value === null ? '' : value.trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || value.length <= LIMITS.organizationId, {
    message: `A parent organization identifier may not exceed ${LIMITS.organizationId} characters`,
  });

/**
 * The organization statuses this service will let conduct authority.
 *
 * organization-service's `OrganizationStatus` enum
 * (`services/organization-service/prisma/schema.prisma`) has exactly these four
 * members today. The list is duplicated here rather than imported for the same
 * A-02 reason the payload schemas are, and it is an **allow-list on purpose**:
 * a status this service has never heard of, or a blank one, matches nothing and
 * therefore conducts no authority, instead of being read as "not DEACTIVATED,
 * so presumably fine".
 *
 * The value is still *recorded* whatever it says — the vocabulary belongs to
 * another service and refusing to store an unfamiliar status would stall the
 * projection on a value that is unfamiliar rather than wrong. Recording it and
 * refusing to authorize from it are different decisions, and only the second
 * one has to fail closed.
 */
export const ORGANIZATION_DOMAIN_STATUSES = [
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
] as const;

export type OrganizationDomainStatus = (typeof ORGANIZATION_DOMAIN_STATUSES)[number];

/** Whether a projected status is one of the owning service's domain states. */
export function isOrganizationDomainStatus(
  status: string | null,
): status is OrganizationDomainStatus {
  return status !== null && (ORGANIZATION_DOMAIN_STATUSES as readonly string[]).includes(status);
}

/**
 * An organization that is its own parent is the cheapest way to make the
 * upward subtree walk never terminate, and `organization_ref_parent_not_self`
 * refuses to store one. Caught here as well so the failure is a validation
 * failure with a field path rather than a constraint violation that aborts the
 * ingest transaction — both fail closed, but only one of them says what is
 * wrong.
 */
const notSelfParented = (
  value: { organizationId: string; parent: string | null },
  ctx: z.RefinementCtx,
  path: string,
): void => {
  if (value.parent !== null && value.parent === value.organizationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: 'An organization may not be its own parent',
    });
  }
};

const organizationCreated = z
  .object({
    organizationId: identifier,
    status: z.string(),
    parentId: parentIdentifier,
    path: z.string().nullable(),
    depth: z.number().int(),
  })
  .superRefine((value, ctx) =>
    notSelfParented(
      { organizationId: value.organizationId, parent: value.parentId },
      ctx,
      'parentId',
    ),
  );

const organizationMoved = z
  .object({
    organizationId: identifier,
    newParentId: parentIdentifier,
    newPath: z.string().nullable(),
  })
  .superRefine((value, ctx) =>
    notSelfParented(
      { organizationId: value.organizationId, parent: value.newParentId },
      ctx,
      'newParentId',
    ),
  );

const organizationStatusChanged = z.object({
  organizationId: identifier,
  newStatus: z.string(),
  /** The cascade. A status change on a parent suspends its whole subtree. */
  affectedIds: z.array(z.string()),
});

/**
 * One instruction for the projection, already validated and bounded.
 *
 * Three kinds rather than one wide record, because the three events know
 * genuinely different things and a single shape would need "undefined means do
 * not touch this column", which is the encoding that eventually clears a parent
 * link by accident.
 */
export type OrganizationProjection =
  | {
      readonly kind: 'CREATED';
      readonly organizationId: string;
      readonly parentOrganizationId: string | null;
      readonly hierarchyPath: string | null;
      readonly hierarchyDepth: number;
      readonly status: string;
      readonly observedAt: Date;
    }
  | {
      readonly kind: 'MOVED';
      readonly organizationId: string;
      readonly parentOrganizationId: string | null;
      readonly hierarchyPath: string | null;
      readonly observedAt: Date;
    }
  | {
      readonly kind: 'STATUS_CHANGED';
      readonly organizationId: string;
      readonly status: string;
      /** Includes `organizationId` itself, de-duplicated, bounded. */
      readonly affectedOrganizationIds: readonly string[];
      readonly observedAt: Date;
    };

/**
 * The largest cascade one `ORGANIZATION_STATUS_CHANGED` may carry into a single
 * statement.
 *
 * A suspension at the top of a large union names every descendant in
 * `affectedIds`. The list is applied in chunks of this size rather than as one
 * statement, so a wide cascade cannot build a query large enough to be refused
 * by the server — which would dead-letter the event and leave the projection
 * believing a suspended subtree is still active.
 */
export const STATUS_CASCADE_CHUNK = 500;

function bound(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function boundOptional(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : bound(trimmed, max);
}

/** True when this delivery is one the hierarchy projection cares about. */
export function isOrganizationProjectionEvent(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): boolean {
  // The topic comes from broker delivery metadata rather than from the
  // envelope, for the same reason the audit row's `sourceTopic` does: a
  // producer must not be able to assert that its message shapes another
  // service's authorization projection by naming a topic it never published to.
  if (delivery.topic !== ORGANIZATION_TOPIC) return false;
  return (Object.values(ORGANIZATION_PROJECTION_EVENTS) as string[]).includes(envelope.eventName);
}

/**
 * Validates the payload and returns the projection instruction, or `null` when
 * this envelope is not one of the three.
 *
 * Throws `ZodError` on a malformed payload. That is the fail-closed choice and
 * it is deliberate: the caller turns it into the same retry-then-dead-letter
 * path a malformed envelope already takes (ADR-053 § 9). Recording the audit
 * row while silently skipping the projection would leave the hierarchy
 * permanently wrong with nothing to notice — the silent gap the ADR names as
 * worse than an outage — and a hierarchy that is wrong is a
 * cross-tenant read.
 *
 * The error carries Zod's own issue paths, which are **field names**. No value
 * from the payload is placed in the message here or by the caller.
 */
export function toOrganizationProjection(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): OrganizationProjection | null {
  if (!isOrganizationProjectionEvent(envelope, delivery)) return null;

  const observedAt = new Date(envelope.occurredAt);

  switch (envelope.eventName) {
    case ORGANIZATION_PROJECTION_EVENTS.CREATED: {
      const payload = organizationCreated.parse(envelope.payload);
      return {
        kind: 'CREATED',
        organizationId: payload.organizationId,
        // Already an identifier or null — never truncated. See `parentIdentifier`.
        parentOrganizationId: payload.parentId,
        hierarchyPath: boundOptional(payload.path, LIMITS.hierarchyPath),
        hierarchyDepth: payload.depth,
        status: bound(payload.status.trim(), LIMITS.status),
        observedAt,
      };
    }

    case ORGANIZATION_PROJECTION_EVENTS.MOVED: {
      const payload = organizationMoved.parse(envelope.payload);
      return {
        kind: 'MOVED',
        organizationId: payload.organizationId,
        // Already an identifier or null — never truncated. See `parentIdentifier`.
        parentOrganizationId: payload.newParentId,
        hierarchyPath: boundOptional(payload.newPath, LIMITS.hierarchyPath),
        observedAt,
      };
    }

    case ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED: {
      const payload = organizationStatusChanged.parse(envelope.payload);
      // The subject is always included even when the producer left it out of
      // the cascade: a status change that did not change the subject's own
      // status is not a status change, and inferring it here costs nothing.
      const affected = new Set<string>([payload.organizationId]);
      for (const raw of payload.affectedIds) {
        const trimmed = raw.trim();
        // A blank or oversized identifier in the cascade is skipped rather than
        // truncated: truncating would apply the status to a *different*
        // organization, which is the one mistake worth dropping a value for.
        if (trimmed.length === 0 || trimmed.length > LIMITS.organizationId) continue;
        affected.add(trimmed);
      }
      return {
        kind: 'STATUS_CHANGED',
        organizationId: payload.organizationId,
        status: bound(payload.newStatus.trim(), LIMITS.status),
        affectedOrganizationIds: [...affected],
        observedAt,
      };
    }

    default:
      return null;
  }
}
