import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '../common/errors';
import { actorTypeSchema } from './envelope';

/**
 * Path B — the explicit audit-trail contract on `rasta.audit.trail.v1`
 * (ADR-053 §§ 1, 5, 7; AUD-004 Phase A).
 *
 * **Contract only (A-03).** This module validates the *wire representation* a
 * producer puts on the topic and a consumer reads off it — nothing else. It
 * has no business logic and makes no authorization decision:
 *
 *   who may publish `action = 'audit.correction'`         producer, checked
 *                                                            against `SYSTEM_ADMIN`
 *   which fields get masked before they reach `changes`    producer, per
 *                                                            `SENSITIVE_KEYS`
 *   how refusals become one row with `occurrenceCount > 1` producer, per
 *                                                            ADR-053 § 4's
 *                                                            windowed aggregation
 *
 * None of that lives here, and none of it is enforced here. What is enforced
 * here is the shape: bounds, an enum where the ADR names a closed set, and the
 * four correction invariants that are true of the *wire message* regardless of
 * who eventually produces one (§ below).
 *
 * ## What does not exist yet
 *
 * No Kafka client, no outbox writer, no consumer, no `security_event_outbox`
 * table, no correction command endpoint. AUD-004 Phase A is the contract that
 * makes those buildable without guessing the wire shape later; none of them
 * are built by this file, and `docs/events/README.md` § Audit says so
 * truthfully once this phase lands.
 */

/** The event name `docs/events/README.md` § Audit has carried since AUD-001. */
export const AUDIT_EVENT_RECORDED = 'AUDIT_EVENT_RECORDED';

/**
 * The payload schema version below. Bumping it is how a breaking change to
 * this wire shape is made visible — a new `auditTrailPayloadSchemaV2` beside
 * this one, never a silent edit to what "version 1" accepts.
 */
export const AUDIT_EVENT_RECORDED_VERSION = 1;

// ---------------------------------------------------------------------------
// `outcome` — ADR-053 § 5's closed set.
// ---------------------------------------------------------------------------

export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE', 'REFUSED'] as const;
export const auditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

// ---------------------------------------------------------------------------
// `action` — a dotted verb, exactly as ADR-053 § 1's draft schema names it.
// ---------------------------------------------------------------------------

/**
 * `<segment>(.<segment>)+`, every segment `[a-z][a-z0-9_]*`.
 *
 * At least one dot — `asset.decommission` matches, a bare `ASSET_DECOMMISSIONED`
 * does not. That asymmetry is intentional: path A falls back to the raw
 * `eventName` for an event ADR-053 has not mapped a verb for yet (ADR-053 §
 * Context, § 2.1); path B is written for audit from the start and has no such
 * fallback to reach for.
 */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** `audit_event.action VARCHAR(256)` — the persisted column this fills. */
const ACTION_MAX_LENGTH = 256;

export const auditActionSchema = z
  .string()
  .min(1)
  .max(ACTION_MAX_LENGTH)
  .regex(AUDIT_ACTION_PATTERN, 'action must be a dotted verb, e.g. "asset.decommission"');

/** The correction action name ADR-053 § 7 reserves. */
export const AUDIT_CORRECTION_ACTION = 'audit.correction';

// ---------------------------------------------------------------------------
// `actor` — path B always names one; the envelope's `actor` is optional.
// ---------------------------------------------------------------------------

/** `audit_event.actor_id VARCHAR(256)`. */
const ACTOR_ID_MAX_LENGTH = 256;

/** A sanity bound on a role *list*, not on any one role's text. */
const ACTOR_ROLES_MAX = 64;

/**
 * The actor a path-B message always carries.
 *
 * `type` reuses the envelope's own {@link actorTypeSchema} — `USER | SERVICE |
 * SYSTEM` — rather than a second declaration that can drift from it.
 * `ANONYMOUS` is deliberately absent even though the *persisted* row's
 * `actorType` column allows it (ADR-053 § 5): that value exists for path A's
 * fallback when a domain envelope carries no actor at all, and ADR-053 § 4
 * scopes refusal audit to the `403` family only — never `401` — precisely
 * because an unauthenticated caller has no attributable actor and is judged
 * low evidentiary value. A path-B message therefore always has a real actor to
 * name, by construction of what it is used for.
 */
export const auditTrailActorSchema = z
  .object({
    type: actorTypeSchema,
    id: z.string().min(1).max(ACTOR_ID_MAX_LENGTH),
    /** Empty when the actor genuinely has none; never omitted (ADR-053 § 5). */
    roles: z.array(z.string().min(1)).max(ACTOR_ROLES_MAX).default([]),
  })
  .strict();
export type AuditTrailActor = z.infer<typeof auditTrailActorSchema>;

// ---------------------------------------------------------------------------
// `changes` — ADR-053 § 5. Bounded, structural, never a raw payload dump.
// ---------------------------------------------------------------------------

/** The ceiling ADR-053 § 5 point 5 states outright. */
export const AUDIT_CHANGES_MAX_ENTRIES = 50;

/** Keys that would let a naive `target[field] = value` consumer pollute a prototype. */
const UNSAFE_CHANGE_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const CHANGE_FIELD_MAX_LENGTH = 128;
const CHANGE_SCALAR_STRING_MAX_LENGTH = 2000;
const CHANGE_HASH_MAX_LENGTH = 128;

export const auditChangeFieldSchema = z
  .string()
  .min(1)
  .max(CHANGE_FIELD_MAX_LENGTH)
  .refine((value) => !UNSAFE_CHANGE_FIELD_NAMES.has(value), {
    message:
      'field must not be a prototype-pollution-prone key (__proto__, constructor, prototype)',
  });

/**
 * A safe scalar — never an object, an array, `undefined`, `NaN` or `Infinity`.
 *
 * ADR-053 § 5 point 3: a value that is large or structured is carried as
 * `{ hash }`, never as itself. Allowing an object here would let exactly the
 * kind of nested payload dump § 5 exists to forbid back in through `from`/`to`.
 */
const auditChangeScalarSchema = z.union([
  z.string().max(CHANGE_SCALAR_STRING_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** ADR-053 § 5 point 2 — the *fact* of a change is evidence; the value is not. */
export const auditRedactedMarkerSchema = z.object({ redacted: z.literal(true) }).strict();

/** ADR-053 § 5 point 3 — proves a change happened without storing its content. */
export const auditHashedMarkerSchema = z
  .object({ hash: z.string().min(1).max(CHANGE_HASH_MAX_LENGTH) })
  .strict();

export const auditChangeValueSchema = z.union([
  auditChangeScalarSchema,
  auditRedactedMarkerSchema,
  auditHashedMarkerSchema,
]);
export type AuditChangeValue = z.infer<typeof auditChangeValueSchema>;

/**
 * One declared field's before/after. `.strict()` so an entry cannot carry a
 * fourth key a future reader would silently ignore — the same reasoning ADR-053
 * § 5 point 1 states for the array itself: an undeclared field is *absent*,
 * never redacted-and-present, and that has to hold at the entry level too.
 */
export const auditChangeSchema = z
  .object({
    field: auditChangeFieldSchema,
    from: auditChangeValueSchema,
    to: auditChangeValueSchema,
  })
  .strict();
export type AuditChange = z.infer<typeof auditChangeSchema>;

export const auditChangesSchema = z.array(auditChangeSchema).max(AUDIT_CHANGES_MAX_ENTRIES);

// ---------------------------------------------------------------------------
// `errorCode` — a platform ErrorCode, never a free string.
// ---------------------------------------------------------------------------

const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

/** One of `packages/contracts/src/common/errors.ts`'s `ERROR_CODES`. */
export const auditErrorCodeSchema: z.ZodType<ErrorCode> = z.enum(ERROR_CODE_VALUES);

// ---------------------------------------------------------------------------
// `source` — ADR-053 § 5. Only path B can supply either field.
// ---------------------------------------------------------------------------

const IP_MAX_LENGTH = 64; // the longest textual IPv6 form (45 chars) plus margin
const USER_AGENT_MAX_LENGTH = 512; // ADR-053 § 1's draft schema names this bound

export const auditTrailSourceSchema = z
  .object({
    ip: z.string().min(1).max(IP_MAX_LENGTH).optional(),
    userAgent: z.string().min(1).max(USER_AGENT_MAX_LENGTH).optional(),
  })
  .strict();
export type AuditTrailSource = z.infer<typeof auditTrailSourceSchema>;

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** `audit_event.resource_type VARCHAR(128)`. */
const RESOURCE_TYPE_MAX_LENGTH = 128;
/** `audit_event.resource_id VARCHAR(256)`. */
const RESOURCE_ID_MAX_LENGTH = 256;
/** `audit_event.organization_id VARCHAR(128)`. */
const ORGANIZATION_ID_MAX_LENGTH = 128;
/** `audit_event.reason VARCHAR(1000)`. */
const REASON_MAX_LENGTH = 1000;

/**
 * The version-1 payload of `AUDIT_EVENT_RECORDED` on `rasta.audit.trail.v1`.
 *
 * Rides on the standard {@link eventEnvelopeSchema} exactly like every other
 * domain event — ADR-053 § 1: "هیچ Transport تازه، هیچ سازوکار تازه، هیچ
 * Envelope دوم" ("no new transport, no new mechanism, no second envelope").
 * `organizationId` below is the payload's *own* tenant field, in addition to
 * `envelope.tenantId`: ADR-053 § 5's persisted row treats a null
 * `organizationId` as a load-bearing fact — a genuinely platform-scoped action
 * — rather than as an omission, and the envelope's `tenantId` is optional for
 * reasons that have nothing to do with audit (it is unset for some
 * non-tenant-scoped domain events today). This schema validates one payload in
 * isolation and never sees the envelope it will ride inside, so it cannot
 * itself enforce that a producer sets both to the same value; that is an
 * envelope/payload agreement, exercised in this module's own envelope-level
 * test via `parseEnvelope`, and ultimately a producer responsibility.
 *
 * `.strict()` throughout: an unrecognised key is rejected rather than
 * silently dropped, so a producer that mistypes a field name — or a caller
 * that tries to smuggle an undeclared key onto the wire — fails loudly instead
 * of publishing a message nobody asked for.
 */
export const auditTrailPayloadSchemaV1 = z
  .object({
    actor: auditTrailActorSchema,
    /** Optional only for a genuinely platform-scoped action (ADR-053 §§ 5, 10). */
    organizationId: z.string().min(1).max(ORGANIZATION_ID_MAX_LENGTH).optional(),
    action: auditActionSchema,
    resourceType: z.string().min(1).max(RESOURCE_TYPE_MAX_LENGTH),
    /** Always present as a key; `null` for a resource that genuinely has no id. */
    resourceId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).nullable(),
    outcome: auditOutcomeSchema,
    errorCode: auditErrorCodeSchema.optional(),
    /** Bounded and, when present, never empty — never auto-filled from user input. */
    reason: z.string().min(1).max(REASON_MAX_LENGTH).optional(),
    changes: auditChangesSchema.optional(),
    /** `> 1` only for a windowed aggregation of identical refusals (ADR-053 § 4). */
    occurrenceCount: z.number().int().positive().default(1),
    source: auditTrailSourceSchema.optional(),
    /**
     * The `AuditEvent.id` (ULID) being corrected — never the source event id.
     * Present only on a correction; see the invariants below.
     */
    correctionOf: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.correctionOf === undefined) return;

    // ADR-053 § 7 — a correction is a fresh record, never an UPDATE, and it
    // must be traceable to exactly one accountable human. Every rule here is
    // contract-level *shape*: whether the actor holding `SYSTEM_ADMIN` really
    // does is the token's job, checked by the future producer — never encoded
    // here (module-level doc comment above).
    if (payload.action !== AUDIT_CORRECTION_ACTION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: `correctionOf requires action === "${AUDIT_CORRECTION_ACTION}"`,
      });
    }
    if (payload.outcome !== 'SUCCESS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'correctionOf requires outcome === "SUCCESS"',
      });
    }
    if (payload.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'correctionOf requires a non-empty reason',
      });
    }
    if (payload.actor.type !== 'USER') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actor', 'type'],
        message: 'correctionOf requires a human USER actor, never SERVICE or SYSTEM',
      });
    }
  });

export type AuditTrailPayloadV1 = z.infer<typeof auditTrailPayloadSchemaV1>;
