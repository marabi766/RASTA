import { Injectable } from '@nestjs/common';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { assertValidConcludedOutcome, type ConcludedOutcomeInput } from './concluded-outcome';
import type { RecordOutcome } from './performance-event.repository';

/**
 * The append-only concluded-outcome store (ADR-052 step 5).
 *
 * The same two operations and the same redelivery rule as
 * `PerformanceEventRepository`: recorded once per source event, a redelivery
 * that states the same outcome is a `DUPLICATE`, one that states a different
 * outcome under the same event id is refused. Tenant-scoped by the supplier
 * organization; the duplicate comparison is the one unscoped read, and it
 * returns nothing to the caller but a refusal.
 */

/** Every field that states the outcome — all but this store's id, its clock and the trace id. */
export const OUTCOME_FIELDS = [
  'organizationId',
  'sourceEventName',
  'outcomeKind',
  'outcomeKey',
  'occurredAt',
] as const satisfies readonly (keyof ConcludedOutcomeInput)[];

type OutcomeField = (typeof OUTCOME_FIELDS)[number];

const OUTCOME_SELECT = Object.fromEntries(OUTCOME_FIELDS.map((field) => [field, true])) as Record<
  OutcomeField,
  true
>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

export interface ConcludedOutcomeRow extends ConcludedOutcomeInput {
  id: string;
  recordedAt: Date;
}

@Injectable()
export class ConcludedOutcomeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: ExtendedPrismaClient, input: ConcludedOutcomeInput): Promise<RecordOutcome> {
    assertValidConcludedOutcome(input);

    const { count } = await tx.performanceConcludedOutcome.createMany({
      data: [
        {
          id: `PCO_${ulid()}`,
          organizationId: input.organizationId,
          sourceEventId: input.sourceEventId,
          sourceEventName: input.sourceEventName,
          outcomeKind: input.outcomeKind,
          outcomeKey: input.outcomeKey,
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return 'RECORDED';

    const existing = await runUnscoped(
      'a duplicate delivery is compared with the outcome already recorded under its event id',
      () =>
        tx.performanceConcludedOutcome.findUnique({
          where: { sourceEventId: input.sourceEventId },
          select: OUTCOME_SELECT,
        }),
    );
    const differing = existing
      ? OUTCOME_FIELDS.filter((field) => !sameValue(existing[field], input[field]))
      : ['sourceEventId'];
    if (differing.length > 0) {
      // Field names only: the stored row may be another tenant's (S-09).
      throw RastaError.businessRule(
        `Source event ${input.sourceEventId} was already recorded as a different outcome`,
        { differingFields: differing },
      );
    }
    return 'DUPLICATE';
  }

  /** The caller's tenant's concluded outcomes in `[from, to)`, in ADR-052 § 10's order. */
  async listInWindow(from: Date, to: Date): Promise<ConcludedOutcomeRow[]> {
    return this.prisma.client.performanceConcludedOutcome.findMany({
      where: { occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'asc' }, { sourceEventId: 'asc' }],
    });
  }
}
