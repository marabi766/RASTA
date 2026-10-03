import { z } from 'zod';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import {
  ECONOMIC_RECONCILIATION_CONTRACT,
  EVIDENCE_REFERENCE_PATTERN,
} from './economic-reconciliation-contract';

export { EVIDENCE_REFERENCE_PATTERN };

/**
 * D-046 (ADR-064 § 6): the allow-listed, versioned projection of the two
 * payment-reconciliation events that record a human decision.
 *
 * The path-A audit row keeps only envelope fields (`audit.mapper.ts`), so on
 * its own it cannot say who approved a resolution, who proposed it, on which
 * evidence, or whether four-eyes applied. This file states which payload fields
 * audit-service keeps for these two events, validates them, and returns one
 * `payment_reconciliation_evidence` row's worth — written by the repository in
 * the same transaction as the audit row.
 *
 * ## Why a local schema and not an import
 *
 * economic-service declares the payloads in its own `src/events/events.ts`, and
 * AGENTS.md A-02 forbids importing it. So this file restates, narrowly, the
 * fields this consumer stores — the same reasoning as
 * `organization-projection.ts`. `payment-reconciliation-projection.spec.ts`
 * reads economic's source as text and fails when the two disagree: a producer
 * field this file has not classified, a different evidence pattern, or a
 * different code list.
 *
 * ## Allow-list, not redaction
 *
 * Every producer field is classified in {@link RESOLVED_FIELDS} and
 * {@link OPERATOR_ACTION_FIELDS} as kept or not. Only the kept ones are read
 * into the row, by name; nothing is copied wholesale, so a field the producer
 * adds tomorrow is not stored until somebody decides it should be. Amounts,
 * currency, provider and any reason text are never kept.
 *
 * ## Two stages: economic's whole contract, then the allow-list
 *
 * The payload is first parsed **in full** against economic's published contract
 * (`economic-reconciliation-contract.ts`, a pinned copy tested against
 * economic's source): every field, including the amounts and the provider this
 * service never stores. A payload economic could not have published is refused
 * there. Only then is it parsed against the storage contract below — stricter
 * about what is kept (identifier shape, the operator group whole or absent, each
 * action's field set) — and the row built from the allow-list. The evidence
 * reference is economic's `EVIDENCE_REFERENCE_PATTERN`, re-exported from the
 * pinned copy; one that does not match is refused, never stripped.
 *
 * ## A known event that fails the contract writes nothing
 *
 * It throws {@link UnprocessableEventError}, which the shared consumer
 * dead-letters at once (`rasta.audit.v1.dlq`) — and because the throw happens
 * before the ingest transaction, neither the audit row nor a partial projection
 * exists. The message names schema field paths and zod issue codes only, never
 * a value from the payload.
 */

/** The topic these events arrive on. Delivery metadata, never the envelope. */
export const ECONOMIC_TOPIC = 'rasta.economic.v1';

export const PAYMENT_RECONCILIATION_EVENTS = {
  RESOLVED: 'PAYMENT_RECONCILIATION_RESOLVED',
  OPERATOR_ACTION: 'PAYMENT_RECONCILIATION_OPERATOR_ACTION',
} as const;

export type PaymentReconciliationEventName =
  (typeof PAYMENT_RECONCILIATION_EVENTS)[keyof typeof PAYMENT_RECONCILIATION_EVENTS];

/**
 * The shape a row is written under, stored as `projection_version`.
 *
 * Bumped only together with a migration that adds the new number to
 * `ck_payment_reconciliation_evidence_version`; rows written under an earlier
 * version are never rewritten.
 */
export const PAYMENT_RECONCILIATION_PROJECTION_VERSION = 1;

/** The event version this projection understands. Any other is refused. */
export const SUPPORTED_EVENT_VERSION = 1;

/**
 * Every field economic's payload declares, and whether audit keeps it.
 *
 * `true` is stored; `false` is read by nothing here. The spec pins this list to
 * economic's schema in both directions, so a producer field can be neither
 * added nor removed without someone deciding its classification.
 */
export const RESOLVED_FIELDS: Readonly<Record<string, boolean>> = Object.freeze({
  paymentIntentId: true,
  organizationId: true,
  walletId: false,
  kind: true,
  marker: false,
  providerRefund: false,
  resolution: true,
  resolvedBy: true,
  attempts: false,
  amountMinor: false,
  currency: false,
  provider: false,
  simulated: false,
  resolvedAt: false,
  resolutionId: true,
  proposedBy: true,
  approvedBy: true,
  evidenceReference: true,
  fourEyes: true,
});

/** As {@link RESOLVED_FIELDS}, for `PAYMENT_RECONCILIATION_OPERATOR_ACTION`. */
export const OPERATOR_ACTION_FIELDS: Readonly<Record<string, boolean>> = Object.freeze({
  paymentIntentId: true,
  organizationId: true,
  walletId: false,
  kind: true,
  action: true,
  actor: true,
  requeueId: true,
  resolutionId: true,
  providerOutcome: true,
  evidenceReference: true,
  proposedBy: true,
  fourEyes: true,
  amountMinor: false,
  currency: false,
  provider: false,
  simulated: false,
  occurredAt: false,
});

export const RECONCILIATION_KINDS = ['REFUND', 'UNCREDITED_REFUND'] as const;
export const RESOLUTION_CODES = [
  'REFUNDED',
  'REFUND_DECLINED',
  'REFUND_NOT_REACHED',
  'UNCREDITED_REFUNDED',
  'UNCREDITED_DECLINED',
  'UNCREDITED_NOT_REACHED',
  'NOTHING_TO_RECONCILE',
] as const;
export const OPERATOR_ACTIONS = ['REQUEUED', 'PROPOSED', 'REJECTED'] as const;
export const PROVIDER_OUTCOMES = ['REFUNDED', 'DECLINED', 'NOT_REACHED'] as const;

/**
 * An identifier or an actor: printable ASCII without whitespace, bounded.
 *
 * Refused rather than truncated when too long — a cut identifier names a
 * different record or a different person. The "no whitespace" rule is what
 * keeps a column meant for an id from carrying a sentence.
 */
const IDENTIFIER_PATTERN = /^[!-~]+$/;
const identifier = (max: number) => z.string().min(1).max(max).regex(IDENTIFIER_PATTERN);
const recordId = identifier(128);
const actorId = identifier(256);
const evidenceReference = z.string().regex(EVIDENCE_REFERENCE_PATTERN);

const resolvedPayload = z
  .object({
    paymentIntentId: recordId,
    organizationId: recordId,
    kind: z.enum(RECONCILIATION_KINDS),
    resolution: z.enum(RESOLUTION_CODES),
    resolvedBy: actorId,
    resolutionId: recordId.optional(),
    proposedBy: actorId.optional(),
    approvedBy: actorId.optional(),
    evidenceReference: evidenceReference.optional(),
    fourEyes: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    // economic sends the operator group as one object (`Resolver.operator`):
    // all five for an approved operator resolution, none for the reconciler's
    // own. Part of it is a contract break, and a row with an approver but no
    // evidence would be the very record D-046 says must not exist.
    const group = [
      value.resolutionId,
      value.proposedBy,
      value.approvedBy,
      value.evidenceReference,
      value.fourEyes,
    ];
    const present = group.filter((field) => field !== undefined).length;
    if (present !== 0 && present !== group.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operator'],
        message: 'An operator resolution names its id, both actors, the evidence and four-eyes',
      });
    }
  });

const operatorActionPayload = z
  .object({
    paymentIntentId: recordId,
    organizationId: recordId,
    kind: z.enum(RECONCILIATION_KINDS),
    action: z.enum(OPERATOR_ACTIONS),
    actor: actorId,
    requeueId: recordId.nullable(),
    resolutionId: recordId.nullable(),
    providerOutcome: z.enum(PROVIDER_OUTCOMES).nullable(),
    evidenceReference: evidenceReference.nullable(),
    proposedBy: actorId.nullable(),
    fourEyes: z.boolean(),
  })
  .superRefine((value, ctx) => {
    // docs/events: REQUEUED names the requeue row that keeps the reason and
    // nothing of a resolution; PROPOSED and REJECTED name the resolution, its
    // outcome, its evidence and its proposer, and no requeue.
    const requeue = value.action === 'REQUEUED';
    const expectPresent: [string, boolean][] = [
      ['requeueId', requeue],
      ['resolutionId', !requeue],
      ['providerOutcome', !requeue],
      ['evidenceReference', !requeue],
      ['proposedBy', !requeue],
    ];
    for (const [field, required] of expectPresent) {
      const present = value[field as keyof typeof value] !== null;
      if (present !== required) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: required ? 'Required for this action' : 'Must be null for this action',
        });
      }
    }
  });

/**
 * One `payment_reconciliation_evidence` row, less the three columns the
 * repository takes from the audit record it is written with
 * (`source_event_id`, `audit_event_id`, `occurred_at`) — so the two rows
 * cannot describe different events.
 */
export interface PaymentReconciliationEvidence {
  readonly projectionVersion: typeof PAYMENT_RECONCILIATION_PROJECTION_VERSION;
  readonly organizationId: string;
  readonly eventName: PaymentReconciliationEventName;
  readonly paymentIntentId: string;
  readonly kind: (typeof RECONCILIATION_KINDS)[number];
  readonly operatorAction: (typeof OPERATOR_ACTIONS)[number] | null;
  readonly actor: string | null;
  readonly resolution: (typeof RESOLUTION_CODES)[number] | null;
  readonly resolvedBy: string | null;
  readonly providerOutcome: (typeof PROVIDER_OUTCOMES)[number] | null;
  readonly resolutionId: string | null;
  readonly requeueId: string | null;
  readonly proposedBy: string | null;
  readonly approvedBy: string | null;
  readonly evidenceReference: string | null;
  readonly fourEyes: boolean | null;
}

/** True when this delivery is one of the two events, on economic's topic. */
export function isPaymentReconciliationEvent(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): boolean {
  // The topic from broker metadata, never the envelope: a message on another
  // topic does not get to write payment-reconciliation evidence by naming one.
  if (delivery.topic !== ECONOMIC_TOPIC) return false;
  return (Object.values(PAYMENT_RECONCILIATION_EVENTS) as string[]).includes(envelope.eventName);
}

/**
 * The field names an issue may be reported under: the schema's own, fixed at
 * build time. Anything else — a key taken from the payload — is reported as
 * `(payload)`, so a property name that carries text never reaches a log line or
 * a dead-letter header (S-09).
 */
const REPORTABLE_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(RESOLVED_FIELDS),
  ...Object.keys(OPERATOR_ACTION_FIELDS),
  'operator',
]);

/** The top-level schema field an issue is about, or `(payload)`. Never a payload-supplied name. */
function fieldOf(issue: z.ZodIssue): string {
  const [first] = issue.path;
  if (first === undefined) return '(payload)';
  return typeof first === 'string' && REPORTABLE_FIELDS.has(first) ? first : '(payload)';
}

/**
 * Schema field names and zod issue codes — both closed sets — and nothing else:
 * never an issue message (some repeat the value received) and never a path
 * segment the payload supplied.
 */
export function describeIssues(error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 8)
    .map((issue) => `${fieldOf(issue)} ${issue.code}`)
    .join('; ');
  return error.issues.length > 8 ? `${issues}; and ${error.issues.length - 8} more` : issues;
}

function refuse(eventName: string, why: string): UnprocessableEventError {
  return new UnprocessableEventError(
    DLQ_REASONS.VALIDATION_FAILED,
    `${eventName} does not satisfy the payment-reconciliation evidence contract ` +
      `v${PAYMENT_RECONCILIATION_PROJECTION_VERSION}: ${why}`,
  );
}

/**
 * Validates the payload and returns the projection, or `null` when this is not
 * one of the two events on `rasta.economic.v1`.
 *
 * Throws {@link UnprocessableEventError} when it is one of them and fails the
 * contract: an unsupported event version, a malformed or incomplete payload, or
 * a payload whose organization or intent is not the envelope's.
 */
export function toPaymentReconciliationEvidence(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): PaymentReconciliationEvidence | null {
  if (!isPaymentReconciliationEvent(envelope, delivery)) return null;
  const eventName = envelope.eventName as PaymentReconciliationEventName;

  if ((envelope.eventVersion ?? 1) !== SUPPORTED_EVENT_VERSION) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `${eventName} v${String(envelope.eventVersion)} has no payment-reconciliation evidence ` +
        `projection; only v${SUPPORTED_EVENT_VERSION} is understood`,
    );
  }

  const projection =
    eventName === PAYMENT_RECONCILIATION_EVENTS.RESOLVED
      ? fromResolved(eventName, envelope.payload)
      : fromOperatorAction(eventName, envelope.payload);

  // The tenant and the aggregate the envelope was published under are what the
  // audit row records. A payload that names another organization or another
  // intent would put evidence under the wrong tenant, so it is refused.
  if (!envelope.tenantId || projection.organizationId !== envelope.tenantId) {
    throw refuse(eventName, 'organizationId is not the envelope tenantId');
  }
  if (projection.paymentIntentId !== envelope.aggregateId) {
    throw refuse(eventName, 'paymentIntentId is not the envelope aggregateId');
  }
  return projection;
}

/**
 * Stage one: the whole payload against economic's published contract. A
 * payload economic could not have published is refused here, whatever the
 * allow-list would have kept from it.
 */
function assertEconomicContract(eventName: PaymentReconciliationEventName, payload: unknown): void {
  const parsed = ECONOMIC_RECONCILIATION_CONTRACT[eventName].safeParse(payload);
  if (!parsed.success) {
    throw refuse(eventName, `economic's event contract: ${describeIssues(parsed.error)}`);
  }
}

function fromResolved(
  eventName: PaymentReconciliationEventName,
  payload: unknown,
): PaymentReconciliationEvidence {
  assertEconomicContract(eventName, payload);
  const parsed = resolvedPayload.safeParse(payload);
  if (!parsed.success) throw refuse(eventName, describeIssues(parsed.error));
  const value = parsed.data;
  return {
    projectionVersion: PAYMENT_RECONCILIATION_PROJECTION_VERSION,
    organizationId: value.organizationId,
    eventName,
    paymentIntentId: value.paymentIntentId,
    kind: value.kind,
    operatorAction: null,
    actor: null,
    resolution: value.resolution,
    resolvedBy: value.resolvedBy,
    providerOutcome: null,
    resolutionId: value.resolutionId ?? null,
    requeueId: null,
    proposedBy: value.proposedBy ?? null,
    approvedBy: value.approvedBy ?? null,
    evidenceReference: value.evidenceReference ?? null,
    fourEyes: value.fourEyes ?? null,
  };
}

function fromOperatorAction(
  eventName: PaymentReconciliationEventName,
  payload: unknown,
): PaymentReconciliationEvidence {
  assertEconomicContract(eventName, payload);
  const parsed = operatorActionPayload.safeParse(payload);
  if (!parsed.success) throw refuse(eventName, describeIssues(parsed.error));
  const value = parsed.data;
  return {
    projectionVersion: PAYMENT_RECONCILIATION_PROJECTION_VERSION,
    organizationId: value.organizationId,
    eventName,
    paymentIntentId: value.paymentIntentId,
    kind: value.kind,
    operatorAction: value.action,
    actor: value.actor,
    resolution: null,
    resolvedBy: null,
    providerOutcome: value.providerOutcome,
    resolutionId: value.resolutionId,
    requeueId: value.requeueId,
    proposedBy: value.proposedBy,
    approvedBy: null,
    evidenceReference: value.evidenceReference,
    fourEyes: value.fourEyes,
  };
}
