import { Inject, Injectable } from '@nestjs/common';
import { allocateStreamSeqSql, buildOutboxRow, runUnscoped } from '@rasta/nest-common';
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
 *
 * ## ADR-051 Phase B3 — the sequence is allocated here, and only here
 *
 * Every event this service produces passes through `enqueue`, so this is the
 * one place a stream position can be handed out, and the one place it can be
 * lost. The order below is the contract: validate, resolve routing, allocate
 * against the *resolved* key, then build and insert. Allocating before routing
 * is settled would number the event against a stream it does not belong to.
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

    // ADR-051 B3. Allocated *after* routing is final and *before* the row is
    // built, inside the caller's transaction: the counter row lock is held to
    // that transaction's commit, so allocation order equals commit order, and a
    // rollback returns the number rather than leaving a gap a consumer could
    // not tell from a lost event.
    //
    // No fallback. If the allocator throws, the throw leaves this method and
    // rolls back the caller's transaction with it — the decision and its
    // announcement are still atomic (A-08), and no unsequenced event is
    // written to stand in for a sequenced one.
    const streamSeq = await allocateStreamSeqSql(tx, SUPPLIER_TOPIC, partition.key);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: SUPPLIER_TOPIC,
        payload,
        organizationId: input.organizationId,
        partitionKey: partition.key,
        streamSeq,
        // The same key the sequence was allocated against, passed explicitly.
        // `buildOutboxRow` refuses a `streamKey` that differs from the
        // partition key, so the envelope cannot label a stream the counter
        // never counted.
        streamKey: partition.key,
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
          // The persisted column, taken from the row `buildOutboxRow` returned
          // rather than from the local variable, so the column and the envelope
          // are the same value by construction and cannot drift apart.
          streamSeq: row.streamSeq,
          // `isStreamHead` is still deliberately unset: maintaining the head is
          // B4, it is not merged, and writing it here would claim a head-of-line
          // guarantee no relay yet enforces.
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
