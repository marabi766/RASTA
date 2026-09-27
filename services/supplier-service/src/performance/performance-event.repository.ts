import { Injectable } from '@nestjs/common';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { assertValidPerformanceEvent, type PerformanceEventInput } from './performance-event';

/**
 * The append-only performance-event store (ADR-052 step 3).
 *
 * Two operations and no third: **record** a fact, and **read** a supplier's
 * facts in the order the calculation uses. There is no update and no delete
 * here because the database refuses both; a wrong fact is corrected by
 * recording a compensating one (ADR-052 § 14).
 *
 * ## Tenant scope
 *
 * `PerformanceEvent` is guarded by the supplier organization the fact is
 * about. A write is stamped — and a mismatched `organizationId` refused — by
 * the guard, from the request context the caller runs in; step 5's consumers
 * will run each event in the context of the supplier it names. Reads are
 * scoped the same way.
 *
 * The one crossing: a duplicate delivery is compared against the row that
 * already holds its `source_event_id`, which may belong to another tenant if a
 * producer ever mislabelled an event. That lookup is unscoped, with its reason,
 * and returns nothing to the caller but a refusal.
 */

export type RecordOutcome = 'RECORDED' | 'DUPLICATE';

/**
 * Every field that states the fact, compared on redelivery (Codex review of
 * #120, finding 4). A redelivery that differs in any of them is the same event
 * id claiming a different fact — a different rating, attribution, time or
 * correction target — and is refused, never reported as a harmless duplicate.
 *
 * Left out, deliberately, and only these:
 *
 *   id             this store's own key, minted per attempt;
 *   recordedAt     when this store counted it — this database's clock;
 *   correlationId  the delivery's trace id: a redelivery through a retry or a
 *                  replay legitimately carries a new one.
 */
export const FACT_FIELDS = [
  'organizationId',
  'sourceEventName',
  'component',
  'outcomeKind',
  'outcomeKey',
  'responsibility',
  'rating',
  'promisedAt',
  'deliveredAt',
  'compensatesSourceEventId',
  'occurredAt',
] as const satisfies readonly (keyof PerformanceEventInput)[];

type FactField = (typeof FACT_FIELDS)[number];
type StoredFact = Pick<PerformanceEventInput, FactField>;

const FACT_SELECT = Object.fromEntries(FACT_FIELDS.map((field) => [field, true])) as Record<
  FactField,
  true
>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** The fact fields on which a redelivery disagrees with what is stored. */
export function differingFactFields(stored: StoredFact, incoming: StoredFact): FactField[] {
  return FACT_FIELDS.filter((field) => !sameValue(stored[field], incoming[field]));
}

export interface PerformanceEventRow extends PerformanceEventInput {
  id: string;
  recordedAt: Date;
}

@Injectable()
export class PerformanceEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Counts a fact exactly once.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` on `source_event_id` (rule 8): a
   * redelivery returns `DUPLICATE` and changes nothing. A redelivery that
   * disagrees with the stored fact — another supplier, another component,
   * another outcome — is refused rather than silently accepted, because it
   * means the same event id now claims a different fact.
   */
  async record(tx: ExtendedPrismaClient, input: PerformanceEventInput): Promise<RecordOutcome> {
    assertValidPerformanceEvent(input);

    const { count } = await tx.performanceEvent.createMany({
      data: [
        {
          id: `PEV_${ulid()}`,
          organizationId: input.organizationId,
          sourceEventId: input.sourceEventId,
          sourceEventName: input.sourceEventName,
          component: input.component,
          outcomeKind: input.outcomeKind,
          outcomeKey: input.outcomeKey,
          responsibility: input.responsibility,
          rating: input.rating,
          promisedAt: input.promisedAt,
          deliveredAt: input.deliveredAt,
          compensatesSourceEventId: input.compensatesSourceEventId,
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return 'RECORDED';

    const existing = await runUnscoped(
      'a duplicate delivery is compared with the fact already counted under its event id',
      () =>
        tx.performanceEvent.findUnique({
          where: { sourceEventId: input.sourceEventId },
          select: FACT_SELECT,
        }),
    );
    const differing = existing ? differingFactFields(existing, input) : ['sourceEventId'];
    if (differing.length > 0) {
      // Names the fields, never their stored values: the stored row may be
      // another tenant's (S-09).
      throw RastaError.businessRule(
        `Source event ${input.sourceEventId} was already counted as a different fact`,
        { differingFields: differing },
      );
    }
    return 'DUPLICATE';
  }

  /**
   * The caller's tenant's facts in `[from, to)`, in ADR-052 § 10's total order
   * `(occurredAt, sourceEventId)` — half-open so no fact is in two windows.
   */
  async listInWindow(from: Date, to: Date): Promise<PerformanceEventRow[]> {
    return this.prisma.client.performanceEvent.findMany({
      where: { occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'asc' }, { sourceEventId: 'asc' }],
    });
  }

  /** One fact of the caller's tenant by its source event id, or `null`. */
  async findBySourceEventId(sourceEventId: string): Promise<PerformanceEventRow | null> {
    return this.prisma.client.performanceEvent.findFirst({ where: { sourceEventId } });
  }
}
