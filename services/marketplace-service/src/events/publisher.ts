import { Inject, Injectable } from '@nestjs/common';
import { buildOutboxRow, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import { MARKETPLACE_TOPIC, SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { validateMarketplacePayload, type MarketplaceEventName } from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * Writes one domain event to the outbox inside the caller's transaction.
 *
 * The single point every event in this service passes through, so that
 * publish-time validation and the partition-key decision each happen exactly
 * once (`docs/07` § 7.8, ADR-036). A caller cannot supply a partition key:
 * while an override exists the policy is advice rather than a rule, which is
 * precisely how Q-26 happened in the economic domain.
 */
@Injectable()
export class EventPublisher {
  constructor(@Inject(ENV) private readonly env: MarketplaceEnv) {}

  async enqueue<N extends MarketplaceEventName>(
    tx: ExtendedPrismaClient,
    input: {
      eventName: N;
      aggregateId: string;
      organizationId: string;
      payload: unknown;
      causationId?: string;
    },
  ): Promise<void> {
    const payload = validateMarketplacePayload(input.eventName, input.payload);
    // Read off the validated payload rather than off a variable at the call
    // site, so the key and what the consumer sees cannot disagree.
    const partition = resolvePartitionKey(input.eventName, payload);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: MARKETPLACE_TOPIC,
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
        },
      }),
    );
  }
}

/** Identifier prefixes for this service's aggregates. */
export const ID_PREFIX = {
  product: 'PRD',
  offer: 'OFR',
  order: 'ORD',
  orderLine: 'OLN',
  fulfillment: 'FUL',
  dispute: 'DSP',
  review: 'REV',
  history: 'OSH',
  priceHistory: 'OPH',
} as const;

export function newId(prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX]): string {
  return `${prefix}_${ulid()}`;
}
