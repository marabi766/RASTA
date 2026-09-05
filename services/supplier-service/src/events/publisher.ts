import { Inject, Injectable } from '@nestjs/common';
import { buildOutboxRow, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import { SERVICE_NAME, SUPPLIER_TOPIC, type SupplierEnv } from '../config/env';
import { validateSupplierPayload, type SupplierEventName } from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * Writes one domain event to the outbox inside the caller's transaction.
 *
 * The single point every event in this service passes through, so publish-time
 * validation and the partition-key decision each happen exactly once
 * (`docs/07` § 7.8, ADR-036). A caller cannot supply a partition key: while an
 * override exists the policy is advice rather than a rule.
 *
 * Being inside the caller's transaction is the whole guarantee (AGENTS.md
 * A-08): the approval row and the `SUPPLIER_QUALIFIED` announcing it commit
 * together or not at all. An event for a decision that rolled back would tell
 * marketplace-service to un-hide a supplier nobody approved.
 *
 * ## The outbox row is written unscoped, and that is the standing exception
 *
 * The tenant guard scopes the five domain models. `OutboxMessage` is exempt: it
 * is platform plumbing written by a relay that has no request context, and it
 * carries its own `organization_id` for filtering. The crossing is declared
 * with a written reason so an auditor can enumerate it.
 */
@Injectable()
export class EventPublisher {
  constructor(@Inject(ENV) private readonly env: SupplierEnv) {}

  async enqueue<N extends SupplierEventName>(
    tx: ExtendedPrismaClient,
    input: {
      eventName: N;
      /** The aggregate the event is about — a qualification, a suspension. */
      aggregateId: string;
      organizationId: string;
      payload: unknown;
      causationId?: string;
    },
  ): Promise<void> {
    const payload = validateSupplierPayload(input.eventName, input.payload);
    // Read off the validated payload, never off the call site, so the key and
    // what the consumer sees cannot disagree (the Q-26 failure).
    const partition = resolvePartitionKey(input.eventName, payload);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: SUPPLIER_TOPIC,
        payload,
        organizationId: input.organizationId,
        partitionKey: partition.key,
        ...(input.causationId ? { causationId: input.causationId } : {}),
      },
      { producer: SERVICE_NAME, producerVersion: this.env.SERVICE_VERSION },
    );

    await runUnscoped('the outbox is platform plumbing and carries its own tenant column', () =>
      tx.outboxMessage.create({
        data: {
          id: row.id,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventName: row.eventName,
          eventVersion: row.eventVersion,
          topic: row.topic,
          partitionKey: row.partitionKey,
          payload: row.payload as object,
          headers: row.headers,
          organizationId: row.organizationId,
          correlationId: row.correlationId,
          createdAt: row.createdAt,
          // `streamSeq` and `isStreamHead` are deliberately not set. ADR-051
          // B3 allocates the sequence and B4 maintains the head; neither is
          // merged, and writing either from here would fabricate an ordering
          // guarantee that does not exist (D-027).
        },
      }),
    );
  }
}

/**
 * Identifier prefixes for this service's aggregates.
 *
 * Organization-agnostic (AGENTS.md A-05). A ULID and a type prefix, and nothing
 * that encodes a province, an organization type or a tenant — an id that named
 * "Yazd" or "دهیاری" would make a structural assumption the platform explicitly
 * refuses, and would leak a tenant into every log line that carried it.
 */
export const ID_PREFIX = {
  supplier: 'SUP',
  capability: 'SCP',
  qualification: 'QLF',
  evidence: 'QEV',
  suspension: 'SSP',
} as const;

export function newId(prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX]): string {
  return `${prefix}_${ulid()}`;
}
