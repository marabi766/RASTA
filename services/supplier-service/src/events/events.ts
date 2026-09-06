import { z } from 'zod';
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
 * The catalogue lists five events for this service. Four are below. The fifth
 * carries `score` and `breakdown`, and there is no formula: Q-12 — the weights
 * of quality, time, satisfaction and dispute rate — is open, and the "equal
 * weights" line in `docs/24` is a placeholder inside an open question rather
 * than an approved policy.
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
 * ## The reinstatement gap
 *
 * There is no `SUPPLIER_REINSTATED` in the platform catalogue and none is
 * published here. A consumer that hides a supplier's offers on this event has
 * nothing that tells it to stop, so it must re-read this service rather than
 * treat the suspension as permanent. Recorded as a known issue and an
 * Integration Handoff item rather than closed by inventing an event this
 * service has no mandate to add.
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

export const SUPPLIER_EVENT_SCHEMAS = {
  SUPPLIER_REGISTERED: supplierRegisteredPayload,
  SUPPLIER_QUALIFIED: supplierQualifiedPayload,
  SUPPLIER_REJECTED: supplierRejectedPayload,
  SUPPLIER_SUSPENDED: supplierSuspendedPayload,
} as const satisfies Record<SupplierEventName, z.ZodTypeAny>;

/**
 * Validates a payload at publish time, not only in a test.
 *
 * `docs/07` § 7.8 requires runtime validation: a contract checked only by a
 * test is a contract that holds until somebody adds a field in a hurry. Thrown
 * inside the caller's transaction, so an invalid payload rolls back the state
 * change too rather than committing a fact nobody will hear about.
 */
export function validateSupplierPayload<N extends SupplierEventName>(
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
