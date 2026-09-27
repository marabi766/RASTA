import { z } from 'zod';
import { PERFORMANCE_COMPONENTS } from '../performance/components';
import { SUPPLIER_CAPABILITIES } from '../supplier/capabilities';

/**
 * Events published by supplier-service, on `rasta.supplier.v1`.
 *
 * The names come from the platform catalogue (`docs/04` § 4.10,
 * `docs/events/README.md` § Supplier). The payloads are defined here because
 * this service owns them; filling in another service's contract is inventing a
 * fact you do not own (ADR-032).
 *
 * ## PERFORMANCE_SCORE_UPDATED is not here, and that is the point
 *
 * The catalogue lists six supplier events for this service. Five are below. The
 * sixth carries `score` and `breakdown`. ADR-052 has since decided the formula
 * (Q-12), but no score is computed yet: the calculation engine is Phase B step
 * 6 and the event is step 8. Until a real computation exists there is nothing
 * true to publish.
 *
 * Publishing it with an invented number would be worse than not publishing it.
 * `marketplace-service` ranks search results, and ADR-042 records that it
 * currently sorts on price and delivery time *because no score exists*. A
 * fabricated score would silently become the platform's ranking authority, and
 * nobody downstream could tell it apart from a real one. So the event is absent
 * until somebody decides what it means — the same reasoning ADR-041 applied in
 * the other direction when it refused to answer `false` for a check nobody had
 * made.
 *
 * ## What these payloads never carry
 *
 * **No evidence document identifiers, no decision notes, no suspension
 * internals beyond the stated reason.** An event lives seven days in a log
 * every service can read (`docs/07` § 7.3). A document id on that log would let
 * any consumer with document-service credentials try to fetch a supplier's
 * private licence, bypassing this service's authorization entirely; a reviewer's
 * private note would be published to services with no business reading it.
 *
 * ## What these payloads never claim
 *
 * `SUPPLIER_QUALIFIED` means: a named human with a platform-operator role
 * recorded an approval, at a stated time, for stated capabilities. It does
 * **not** mean any document was fetched, opened, scanned, or found authentic,
 * current or legally valid — this service does not call document-service at all
 * (see `qualification_evidence` in the schema). A consumer must not render it
 * as "verified documents".
 */

export const SUPPLIER_EVENTS = {
  SUPPLIER_REGISTERED: 'SUPPLIER_REGISTERED',
  SUPPLIER_QUALIFIED: 'SUPPLIER_QUALIFIED',
  SUPPLIER_REJECTED: 'SUPPLIER_REJECTED',
  SUPPLIER_SUSPENDED: 'SUPPLIER_SUSPENDED',
  SUPPLIER_REINSTATED: 'SUPPLIER_REINSTATED',
} as const;

export type SupplierEventName = (typeof SUPPLIER_EVENTS)[keyof typeof SUPPLIER_EVENTS];

const identifier = z.string().min(1).max(64);
const isoTimestamp = z.string().min(1);
const capability = z.enum(SUPPLIER_CAPABILITIES);

/**
 * A supplier profile was created.
 *
 * Carries the capabilities the organization **claims**, which is not the same
 * fact as what it has been qualified for. The field is named `capabilities`
 * rather than `qualifiedFor` precisely so a consumer cannot read one as the
 * other; `SUPPLIER_QUALIFIED` is the only event that speaks about qualification.
 */
export const supplierRegisteredPayload = z
  .object({
    supplierId: identifier,
    organizationId: identifier,
    displayName: z.string().min(1).max(200),
    /** Claimed, not qualified. Sorted, so the payload is stable for a fixed set. */
    capabilities: z.array(capability).min(1).max(SUPPLIER_CAPABILITIES.length),
    registeredBy: identifier,
    registeredAt: isoTimestamp,
  })
  .strict();

/**
 * A platform operator approved one qualification.
 *
 * `qualifiedFor` is an array with exactly one member in this phase, because one
 * submission covers one capability. It is an array rather than a scalar because
 * the catalogue names it that way and because a future batched approval must
 * not need a new event version.
 *
 * `decidedBy` is on the wire deliberately: an approval that cannot name who
 * made it is not auditable downstream either, and the consumer that hides or
 * shows a supplier on the strength of this event should be able to say who
 * caused that.
 */
export const supplierQualifiedPayload = z
  .object({
    supplierId: identifier,
    organizationId: identifier,
    qualificationId: identifier,
    qualifiedFor: z.array(capability).min(1),
    decidedBy: identifier,
    decidedAt: isoTimestamp,
  })
  .strict();

/**
 * A platform operator rejected one qualification.
 *
 * `reason` is the operator's stated reason. The reviewer's longer private note
 * is **not** carried: it is written for the platform's own record, and a
 * seven-day log every service reads is not where it belongs.
 */
export const supplierRejectedPayload = z
  .object({
    supplierId: identifier,
    organizationId: identifier,
    qualificationId: identifier,
    rejectedFor: z.array(capability).min(1),
    reason: z.string().min(1).max(500),
    decidedBy: identifier,
    decidedAt: isoTimestamp,
  })
  .strict();

/**
 * A supplier was suspended.
 *
 * ## About `until`
 *
 * The catalogue names this field, so it is here. It is **always `null`** in this
 * phase, and `null` is a meaningful answer rather than a missing one: it says
 * the suspension has no end date and runs until somebody explicitly reinstates.
 * A timed suspension would need a rule about who sets the period and what
 * happens when it lapses, and no accepted document states one.
 *
 * The field is nullable rather than omitted because a consumer must be able to
 * distinguish "no end date" from "this producer does not tell you" — the same
 * distinction ADR-041 drew between `false` and `UNAVAILABLE`.
 *
 * ## Its counterpart
 *
 * `SUPPLIER_REINSTATED` closes the same episode (`suspensionId`) and is the
 * event a consumer that hid this supplier's offers waits for.
 */
export const supplierSuspendedPayload = z
  .object({
    supplierId: identifier,
    organizationId: identifier,
    suspensionId: identifier,
    reason: z.string().min(1).max(500),
    /** Always null: suspension runs until an explicit reinstatement. */
    until: z.null(),
    suspendedBy: identifier,
    suspendedAt: isoTimestamp,
  })
  .strict();

/**
 * A platform operator lifted a supplier's suspension.
 *
 * Added for the global audit's L7-14: the reinstatement is a state change —
 * `SUSPENDED → ACTIVE`, and the episode stamped closed — and it published
 * nothing, so audit-service held the suspension and never its end
 * (AGENTS.md S-06). Its shape mirrors `SUPPLIER_SUSPENDED`: the same episode
 * id, the operator's stated reason, who and when. Nothing about
 * qualifications is carried — reinstating makes no new decision about them
 * (`isCurrentlyQualified` simply stops withholding what was approved).
 */
export const supplierReinstatedPayload = z
  .object({
    supplierId: identifier,
    organizationId: identifier,
    /** The episode this closes — the `suspensionId` of its `SUPPLIER_SUSPENDED`. */
    suspensionId: identifier,
    reason: z.string().min(1).max(500),
    reinstatedBy: identifier,
    reinstatedAt: isoTimestamp,
  })
  .strict();

// ---------------------------------------------------------------------------
// The performance formula — audit of a platform-wide configuration change
// ---------------------------------------------------------------------------

/**
 * Every change to the platform-wide scoring formula (ADR-052 § 3, § 18, S-06).
 *
 * A separate set from `SUPPLIER_EVENTS` because they are about no supplier:
 * a formula version belongs to the platform, so these events carry no tenant
 * and are keyed by the formula version's own id, not by `supplierId` (PM
 * ruling, `routing.ts`). audit-service reads them off `rasta.supplier.v1`
 * like every other event on the topic.
 *
 * They announce configuration, never a score: `PERFORMANCE_SCORE_UPDATED` is
 * still ADR-052 step 8 and is still not here.
 */
export const PERFORMANCE_FORMULA_EVENTS = {
  PERFORMANCE_FORMULA_VERSION_CREATED: 'PERFORMANCE_FORMULA_VERSION_CREATED',
  PERFORMANCE_FORMULA_VERSION_ACTIVATED: 'PERFORMANCE_FORMULA_VERSION_ACTIVATED',
  PERFORMANCE_FORMULA_VERSION_RETIRED: 'PERFORMANCE_FORMULA_VERSION_RETIRED',
} as const;

export type PerformanceFormulaEventName =
  (typeof PERFORMANCE_FORMULA_EVENTS)[keyof typeof PERFORMANCE_FORMULA_EVENTS];

/** Every event this service may put in its outbox. */
export type PublishedEventName = SupplierEventName | PerformanceFormulaEventName;

const basisPoints = z.number().int().min(0).max(10_000);
const formulaVersionNumber = z.number().int().positive();

/**
 * A DRAFT version was recorded, with everything it would compute by.
 *
 * The full content rather than a reference: the audit trail should answer
 * "what did the operator propose" without this service's database.
 */
export const performanceFormulaVersionCreatedPayload = z
  .object({
    formulaVersionId: identifier,
    formulaVersion: formulaVersionNumber,
    windowDays: z.number().int().positive(),
    minSampleCount: z.number().int().positive(),
    minCoverageBp: basisPoints,
    ratingMapping: z
      .object({
        scaleMin: z.number().int(),
        scaleMax: z.number().int(),
        minScoreCentis: basisPoints,
        maxScoreCentis: basisPoints,
      })
      .strict(),
    weights: z
      .array(
        z
          .object({
            component: z.enum(PERFORMANCE_COMPONENTS),
            weightBp: basisPoints.min(1),
          })
          .strict(),
      )
      .min(1)
      .max(PERFORMANCE_COMPONENTS.length),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

/** A DRAFT became the platform's one ACTIVE version. */
export const performanceFormulaVersionActivatedPayload = z
  .object({
    formulaVersionId: identifier,
    formulaVersion: formulaVersionNumber,
    /** The version this one replaced; null only for the very first activation. */
    supersededFormulaVersionId: identifier.nullable(),
    activatedBy: identifier,
    activatedAt: isoTimestamp,
  })
  .strict();

/**
 * The ACTIVE version was retired — always by the activation of a successor,
 * named here, in the same transaction.
 */
export const performanceFormulaVersionRetiredPayload = z
  .object({
    formulaVersionId: identifier,
    formulaVersion: formulaVersionNumber,
    successorFormulaVersionId: identifier,
    retiredBy: identifier,
    retiredAt: isoTimestamp,
  })
  .strict();

export const SUPPLIER_EVENT_SCHEMAS = {
  SUPPLIER_REGISTERED: supplierRegisteredPayload,
  SUPPLIER_QUALIFIED: supplierQualifiedPayload,
  SUPPLIER_REJECTED: supplierRejectedPayload,
  SUPPLIER_SUSPENDED: supplierSuspendedPayload,
  SUPPLIER_REINSTATED: supplierReinstatedPayload,
  PERFORMANCE_FORMULA_VERSION_CREATED: performanceFormulaVersionCreatedPayload,
  PERFORMANCE_FORMULA_VERSION_ACTIVATED: performanceFormulaVersionActivatedPayload,
  PERFORMANCE_FORMULA_VERSION_RETIRED: performanceFormulaVersionRetiredPayload,
} as const satisfies Record<PublishedEventName, z.ZodTypeAny>;

/**
 * Validates a payload at publish time, not only in a test.
 *
 * `docs/07` § 7.8 requires runtime validation: a contract checked only by a
 * test is a contract that holds until somebody adds a field in a hurry. Thrown
 * inside the caller's transaction, so an invalid payload rolls back the state
 * change too rather than committing a fact nobody will hear about.
 */
export function validateSupplierPayload<N extends PublishedEventName>(
  eventName: N,
  payload: unknown,
): z.infer<(typeof SUPPLIER_EVENT_SCHEMAS)[N]> {
  const schema = SUPPLIER_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as z.infer<(typeof SUPPLIER_EVENT_SCHEMAS)[N]>;
}
