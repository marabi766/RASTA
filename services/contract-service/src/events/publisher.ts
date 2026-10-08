import { Inject, Injectable } from '@nestjs/common';
import { allocateStreamSeqSql, buildOutboxRow, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import { SERVICE_NAME, CONTRACT_TOPIC, type ContractEnv } from '../config/env';
import { validateContractPayload, type ContractEventName } from './events';
import { AGGREGATE_OF, resolvePartitionKey } from './routing';

/**
 * Writes one domain event to the outbox inside the caller's transaction.
 *
 * The single point every event in this service passes through, so publish-time
 * validation and the partition-key decision each happen exactly once
 * (`docs/07` § 7.8, ADR-036). A caller cannot supply a partition key.
 *
 * Being inside the caller's transaction is the whole guarantee (AGENTS.md
 * A-08): a draft contract and the `CONTRACT_DRAFTED` announcing it commit
 * together or not at all.
 *
 * ## The outbox row is written unscoped, and that is the standing exception
 *
 * The tenant guard scopes the domain models. `OutboxMessage` is exempt: it is
 * platform plumbing written by a relay that has no request context, and it carries
 * its own `organization_id` for filtering. The crossing is declared with a written
 * reason so an auditor can enumerate it.
 *
 * ## ADR-051 Phase B3 — the sequence is allocated here, and only here
 *
 * The order below is the contract: validate, resolve routing, allocate against the
 * *resolved* key, then build and insert. Allocating before routing is settled
 * would number the event against a stream it does not belong to.
 */
@Injectable()
export class EventPublisher {
  constructor(@Inject(ENV) private readonly env: ContractEnv) {}

  async enqueue<N extends ContractEventName>(
    tx: ExtendedPrismaClient,
    input: {
      eventName: N;
      /** What the event is about: the contract (`routing.ts`). */
      aggregateId: string;
      organizationId: string;
      payload: unknown;
      causationId?: string;
      /**
       * The instant the fact this event announces was persisted (D-5): required, so the
       * event and the row it announces carry one instant from one clock inside one
       * transaction (`src/shared/clock.ts`).
       */
      occurredAt: Date;
    },
  ): Promise<void> {
    const payload = validateContractPayload(input.eventName, input.payload);
    const partition = resolvePartitionKey(input.eventName, payload);

    // ADR-051 B3. Allocated *after* routing is final and *before* the row is built,
    // inside the caller's transaction: the counter row lock is held to that
    // transaction's commit, so allocation order equals commit order, and a rollback
    // returns the number rather than leaving a gap. No fallback: if the allocator
    // throws, the caller's transaction rolls back with it.
    const streamSeq = await allocateStreamSeqSql(tx, CONTRACT_TOPIC, partition.key);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: CONTRACT_TOPIC,
        payload,
        organizationId: input.organizationId,
        partitionKey: partition.key,
        streamSeq,
        streamKey: partition.key,
        occurredAt: input.occurredAt,
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
          streamSeq: row.streamSeq,
          // `isStreamHead` is deliberately unset: maintaining the head is B4, it is not
          // merged, and writing it here would claim a head-of-line guarantee no relay enforces.
        },
      }),
    );
  }
}

/**
 * Identifier prefixes for this service's aggregates.
 *
 * `CTR` is the platform prefix for a contract (`@rasta/contracts` `ID_PREFIXES.contract`).
 * Organization-agnostic (AGENTS.md A-05): a ULID and a type prefix, nothing that
 * encodes a province, an organization type or a tenant.
 */
export const ID_PREFIX = {
  contract: ID_PREFIXES.contract,
  /** A contract's signature record (this service's own prefix: the shared list has none). */
  signature: 'CSG',
  /** An approval policy and its steps, the prefixes construction-service gives its own. */
  policy: 'APL',
  policyStep: 'APS',
} as const;

export function newId(prefix: (typeof ID_PREFIX)[keyof typeof ID_PREFIX]): string {
  return `${prefix}_${ulid()}`;
}
