import { z } from 'zod';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import { RESPONSIBILITY_ATTRIBUTIONS } from './components';
import type { ConcludedOutcomeInput } from './concluded-outcome';
import type { PerformanceEventInput } from './performance-event';

/**
 * What a `rasta.marketplace.v1` event contributes to a supplier's performance
 * (ADR-052 step 5). Pure: no database, no clock, no context — every decision
 * the consumer makes about an event's *content* is made here.
 *
 * ## The payloads are this service's copy, on purpose
 *
 * marketplace-service owns these contracts (`src/events/events.ts` there), and
 * importing from another service is forbidden (AGENTS.md A-02). So the fields
 * this consumer reads are restated here — only those, and only as strictly as
 * the fact needs. A field marketplace adds later is ignored; a field this
 * consumer needs and does not get is a `VALIDATION_FAILED` dead letter, never a
 * guess.
 *
 * ## What each event is, and what it is not
 *
 *   ORDER_CREATED           ON_TIME, the promise (`promisedDeliveryAt`). An
 *                           order created before ADR-052 § 1-a carries none,
 *                           and is not a fact — nothing is inferred from the
 *                           offer's lead time.
 *   ORDER_FULFILLED         ON_TIME, the delivery (`fulfilledAt`). How the two
 *                           become a score is docs/24 Q-79, still open.
 *   REVIEW_SUBMITTED        CUSTOMER_SATISFACTION, the raw `rating` 1..5.
 *   ORDER_DISPUTE_RESOLVED  DISPUTE_ABSENCE, the operator's `responsibility`,
 *                           with the dispute id: a later resolution of the
 *                           same dispute supersedes an earlier one.
 *   ORDER_CANCELLED         CANCELLATION_ABSENCE, the structured
 *                           `cancellationCause`. One cancelled before ADR-052
 *                           § 1-c carries none, and is not a fact — the
 *                           free-text `reason` is never read (rule 14).
 *   ORDER_COMPLETED         a concluded outcome — no component (docs/24 Q-78).
 *
 * Everything else on the topic contributes nothing and is skipped.
 */

/** The only version of each payload this consumer knows. */
export const SUPPORTED_EVENT_VERSION = 1;

const text = z.string().min(1);
const instant = z.string().datetime({ offset: true });
const attribution = z.enum(RESPONSIBILITY_ATTRIBUTIONS);

/** The parties every consumed event names. § 5 reads the buyer; the fact is the supplier's. */
const parties = {
  orderId: text,
  buyerOrganizationId: text,
  supplierOrganizationId: text,
};

export const CONSUMED_PAYLOADS = {
  ORDER_CREATED: z.object({ ...parties, promisedDeliveryAt: instant.optional() }),
  ORDER_FULFILLED: z.object({ ...parties, fulfilledAt: instant }),
  REVIEW_SUBMITTED: z.object({ ...parties, rating: z.number().int().min(1).max(5) }),
  ORDER_DISPUTE_RESOLVED: z.object({ ...parties, disputeId: text, responsibility: attribution }),
  ORDER_CANCELLED: z.object({ ...parties, cancellationCause: attribution.optional() }),
  ORDER_COMPLETED: z.object({ ...parties }),
} as const;

export type ConsumedEventName = keyof typeof CONSUMED_PAYLOADS;

export const CONSUMED_EVENT_NAMES = Object.keys(CONSUMED_PAYLOADS) as ConsumedEventName[];

function isConsumed(eventName: string): eventName is ConsumedEventName {
  return Object.prototype.hasOwnProperty.call(CONSUMED_PAYLOADS, eventName);
}

/** Why a consumed event produced no row. A closed set, so it can label a metric. */
export const NOT_A_FACT_REASONS = ['promise_absent', 'attribution_absent'] as const;
export type NotAFactReason = (typeof NOT_A_FACT_REASONS)[number];

export type MarketplaceContribution =
  | { kind: 'FACT'; fact: PerformanceEventInput }
  | { kind: 'CONCLUDED_OUTCOME'; outcome: ConcludedOutcomeInput }
  | { kind: 'NOT_A_FACT'; supplierOrganizationId: string; reason: NotAFactReason };

/**
 * The contribution of one marketplace event, or `null` for an event this
 * consumer does not read.
 *
 * Throws `UnprocessableEventError` — dead-lettered at once, never retried —
 * for an event it reads and can never accept:
 *
 *   SCHEMA_VERSION_UNSUPPORTED  a version other than 1;
 *   VALIDATION_FAILED           a payload without a field the fact needs;
 *   SOURCE_UNCONFIRMED          ADR-061 § 5 — the envelope's tenant is not the
 *                               payload's buyer. marketplace stamps every one
 *                               of these events with the buyer's tenant, so a
 *                               mismatch is either a producer defect or a
 *                               forged event, and either way not a fact.
 */
export function marketplaceContribution(envelope: EventEnvelope): MarketplaceContribution | null {
  const { eventName } = envelope;
  if (!isConsumed(eventName)) return null;

  if (envelope.eventVersion !== SUPPORTED_EVENT_VERSION) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `${eventName} ${envelope.eventId} is version ${envelope.eventVersion}; this consumer reads ${SUPPORTED_EVENT_VERSION}`,
    );
  }

  const parsed = CONSUMED_PAYLOADS[eventName].safeParse(envelope.payload);
  if (!parsed.success) {
    // Paths only: a message never repeats payload values (S-09).
    const paths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `${eventName} ${envelope.eventId} payload is not what this consumer reads: ${paths.join(', ')}`,
    );
  }
  const payload = parsed.data;
  // `payload` was parsed by `CONSUMED_PAYLOADS[eventName]`, so within each case
  // below it is exactly that event's shape; TypeScript cannot follow the
  // correlation through the index, so this names it once.
  const as = <N extends ConsumedEventName>(_name: N) =>
    payload as z.infer<(typeof CONSUMED_PAYLOADS)[N]>;

  // ADR-061 § 5, before anything is derived from the payload.
  if (!envelope.tenantId || envelope.tenantId !== payload.buyerOrganizationId) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `${eventName} ${envelope.eventId}: the envelope's tenant is not the payload's buyer`,
    );
  }

  const supplierOrganizationId = payload.supplierOrganizationId;
  const base = {
    organizationId: supplierOrganizationId,
    sourceEventId: envelope.eventId,
    sourceEventName: eventName,
    outcomeKind: 'ORDER' as const,
    outcomeKey: payload.orderId,
    occurredAt: new Date(envelope.occurredAt),
    correlationId: envelope.correlationId,
  };
  const noMeasurement = {
    responsibility: null,
    rating: null,
    promisedAt: null,
    deliveredAt: null,
    disputeId: null,
    compensatesSourceEventId: null,
  };
  const fact = (
    overrides: Partial<PerformanceEventInput> & Pick<PerformanceEventInput, 'component'>,
  ): MarketplaceContribution => ({
    kind: 'FACT',
    fact: { ...base, ...noMeasurement, ...overrides },
  });

  switch (eventName) {
    case 'ORDER_CREATED': {
      const { promisedDeliveryAt } = as('ORDER_CREATED');
      if (promisedDeliveryAt === undefined) {
        return { kind: 'NOT_A_FACT', supplierOrganizationId, reason: 'promise_absent' };
      }
      return fact({ component: 'ON_TIME', promisedAt: new Date(promisedDeliveryAt) });
    }
    case 'ORDER_FULFILLED': {
      const { fulfilledAt } = as('ORDER_FULFILLED');
      return fact({ component: 'ON_TIME', deliveredAt: new Date(fulfilledAt) });
    }
    case 'REVIEW_SUBMITTED': {
      const { rating } = as('REVIEW_SUBMITTED');
      return fact({ component: 'CUSTOMER_SATISFACTION', rating });
    }
    case 'ORDER_DISPUTE_RESOLVED': {
      const { disputeId, responsibility } = as('ORDER_DISPUTE_RESOLVED');
      return fact({ component: 'DISPUTE_ABSENCE', responsibility, disputeId });
    }
    case 'ORDER_CANCELLED': {
      const { cancellationCause } = as('ORDER_CANCELLED');
      if (cancellationCause === undefined) {
        return { kind: 'NOT_A_FACT', supplierOrganizationId, reason: 'attribution_absent' };
      }
      return fact({ component: 'CANCELLATION_ABSENCE', responsibility: cancellationCause });
    }
    case 'ORDER_COMPLETED':
      return { kind: 'CONCLUDED_OUTCOME', outcome: base };
  }
}
