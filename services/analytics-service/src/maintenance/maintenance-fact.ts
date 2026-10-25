import { DLQ_REASONS, digitsToBigInt, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  invalidPayloadError,
  requireEnvelopeTenant,
} from '@rasta/nest-common';
import { z } from 'zod';

/**
 * The consumer-side contract of `MAINTENANCE_COMPLETED` and the fact it becomes (ADR-071
 * §§ 2–3, RUN-001 PR 1).
 *
 * ## A local schema, not an import
 *
 * maintenance-service declares the payload in its own `src/maintenance/events.ts`, which
 * this service may not import (A-02). This file states, in one place, only the fields this
 * projection reads — as a schema, not a cast — so a producer that drops `completedAt` does
 * not silently produce a fact with no date; it produces a dead-lettered event and an alert.
 * Extra fields are accepted (a producer adding one must not dead-letter this consumer);
 * missing or wrongly-typed fields this projection reads are refused. Tolerant of growth,
 * strict about what it uses (the rule of audit-service's `organization-projection.ts`).
 *
 * ## Stricter than the producer where the fact needs it
 *
 * The producer types `type` and `currency` as any string and the cost as up to 30 digits.
 * A fact is kept for good and summed, so it needs more: a type in the shape of a code (an
 * unknown *value* is counted under its own name, docs/07 § 7.8), an ISO 4217 currency, a
 * cost that fits a bigint, and a whole, non-negative downtime. Anything else is a producer
 * defect, dead-lettered as `VALIDATION_FAILED` rather than stored as something it is not.
 */

/** The topic the event arrives on. Delivery metadata, never the envelope. */
export const MAINTENANCE_TOPIC = 'rasta.maintenance.v1';

/** The consumer group, `<service>.<purpose>` (ADR-061 § 3) — also its `processed_event` key. */
export const MAINTENANCE_FACTS_CONSUMER = 'analytics-service.maintenance-facts';

export const MAINTENANCE_COMPLETED = 'MAINTENANCE_COMPLETED';

/** PostgreSQL's bigint, the column the cost is kept in. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Bounds mirrored from the migration, so an oversized value is refused here, not by `22001`. */
const identifier = z.string().trim().min(1).max(128);

const maintenanceCompletedPayload = z.object({
  requestId: identifier,
  assetId: identifier,
  organizationId: identifier,
  type: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  scheduleId: identifier.nullable(),
  completedAt: z.string().datetime({ offset: true }),
  downtimeMinutes: z.number().int().nonnegative().max(2_147_483_647).nullable(),
  totalCostMinor: z
    .string()
    .regex(/^\d{1,19}$/)
    // zod runs this even when the pattern failed, with the raw text: only digits are converted,
    // so a malformed cost is VALIDATION_FAILED, never a SyntaxError quoting it into x-dlq-error.
    .refine((value) => {
      const cost = digitsToBigInt(value);
      return cost === undefined || cost <= BIGINT_MAX;
    }),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/** The names the schema declares — what a dead-letter message may name of a failing payload (S-09). */
export const MAINTENANCE_COMPLETED_FIELDS: readonly string[] = Object.keys(
  maintenanceCompletedPayload.shape,
);

/** One completed maintenance request, as this service keeps it. */
export interface MaintenanceFact {
  readonly organizationId: string;
  readonly requestId: string;
  readonly assetId: string;
  readonly maintenanceType: string;
  readonly scheduleId: string | null;
  readonly completedAt: Date;
  readonly downtimeMinutes: number | null;
  readonly totalCostMinor: bigint;
  readonly currency: string;
  readonly sourceEventId: string;
}

/**
 * The fact an envelope states, or `null` for an event this projection does not read (an
 * unknown name is skipped, docs/07 § 7.6). Throws `UnprocessableEventError` —
 * `VALIDATION_FAILED`, before any marker is written — for a payload that fails its schema,
 * an envelope with no tenant, or a payload whose organization is not the envelope's.
 */
export function toMaintenanceFact(envelope: EventEnvelope): MaintenanceFact | null {
  if (envelope.eventName !== MAINTENANCE_COMPLETED) return null;

  const parsed = maintenanceCompletedPayload.safeParse(envelope.payload);
  if (!parsed.success) {
    throw invalidPayloadError(envelope, parsed.error, MAINTENANCE_COMPLETED_FIELDS);
  }
  const payload = parsed.data;

  // The tenant is the envelope's, and only the envelope's (docs/07 § 7.6 (1)); the payload
  // may confirm it, never replace it.
  const organizationId = requireEnvelopeTenant(envelope, payload.organizationId);

  return {
    organizationId,
    requestId: payload.requestId,
    assetId: payload.assetId,
    maintenanceType: payload.type,
    scheduleId: payload.scheduleId,
    completedAt: new Date(payload.completedAt),
    downtimeMinutes: payload.downtimeMinutes,
    totalCostMinor: BigInt(payload.totalCostMinor),
    currency: payload.currency,
    sourceEventId: envelope.eventId,
  };
}

/** The fields that make two statements of one completion the same fact. */
const COMPARED = [
  'assetId',
  'maintenanceType',
  'scheduleId',
  'completedAt',
  'downtimeMinutes',
  'totalCostMinor',
  'currency',
] as const satisfies readonly (keyof MaintenanceFact)[];

/**
 * Which fields of a second statement of the same completion differ from the fact held.
 * Empty: the same fact, stated again (a republished event) — no second effect. Otherwise
 * a contradiction, which is never applied over the first.
 */
export function contradictions(held: MaintenanceFact, stated: MaintenanceFact): string[] {
  return COMPARED.filter((field) => {
    const a = held[field];
    const b = stated[field];
    if (a instanceof Date && b instanceof Date) return a.getTime() !== b.getTime();
    return a !== b;
  });
}

/**
 * The verdict on a contradiction: dead-lettered at once, since a retry cannot make two
 * different completions one. Identifiers and field names only (S-09) — never a cost.
 */
export function contradictionError(
  envelope: Pick<EventEnvelope, 'eventName' | 'eventId'>,
  held: Pick<MaintenanceFact, 'requestId' | 'sourceEventId'>,
  differing: readonly string[],
): UnprocessableEventError {
  return new UnprocessableEventError(
    DLQ_REASONS.BUSINESS_RULE_VIOLATION,
    `${envelope.eventName} ${envelope.eventId} contradicts the fact held for request ` +
      `${held.requestId} (from event ${held.sourceEventId}; differs in ${differing.join(', ')})`,
  );
}
