import { Inject, Injectable } from '@nestjs/common';
import { allocateStreamSeqSql, buildOutboxRow, runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { ENV } from '../tokens';
import { NOTIFICATION_TOPIC, SERVICE_NAME, type NotificationEnv } from '../config/env';
import {
  AGGREGATE_OF,
  resolvePartitionKey,
  validateNotificationPayload,
  type NotificationEventName,
} from './published';

/**
 * Writes one domain event to the outbox **inside the caller's transaction**.
 *
 * That last part is the whole guarantee (`AGENTS.md` A-08). The `read_at`
 * timestamp and the `NOTIFICATION_READ` announcing it commit together or not at
 * all. The two failure modes it rules out are not symmetric and both are bad:
 * a row moved with no event leaves `audit-service` blind to a state change,
 * which is the deviation `ADR-054 § 3` refused to accept; an event with no row
 * tells the audit log about something that did not happen, which is worse,
 * because a false record is harder to detect than a missing one.
 *
 * Every event this service publishes passes through here, so publish-time
 * validation, the partition-key decision and the sequence allocation each
 * happen exactly once and in the order ADR-051 § B3 requires: validate, resolve
 * routing, allocate against the *resolved* key, then build and insert.
 *
 * ## The outbox row is written unscoped, and that is the standing exception
 *
 * The tenant guard scopes this service's domain models. `OutboxMessage` is
 * exempt: it is platform plumbing written by a relay that has no request
 * context, and it carries its own `organization_id` for filtering. The crossing
 * is declared with a written reason so an auditor can enumerate it.
 */
@Injectable()
export class EventPublisher {
  constructor(@Inject(ENV) private readonly env: NotificationEnv) {}

  async enqueue<N extends NotificationEventName>(
    tx: ExtendedPrismaClient,
    input: {
      eventName: N;
      /** The notification, or the inbox for an inbox-wide action. */
      aggregateId: string;
      organizationId: string;
      payload: unknown;
    },
  ): Promise<string> {
    const payload = validateNotificationPayload(input.eventName, input.payload);
    // Read off the validated payload, never off the call site, so the key and
    // what the consumer sees cannot disagree.
    const partitionKey = resolvePartitionKey(payload);

    // Allocated after routing is final and before the row is built, inside the
    // caller's transaction: the counter row lock is held to that transaction's
    // commit, so allocation order equals commit order, and a rollback returns
    // the number rather than leaving a gap a consumer could not tell from a
    // lost event.
    const streamSeq = await allocateStreamSeqSql(tx, NOTIFICATION_TOPIC, partitionKey);

    const row = buildOutboxRow(
      {
        aggregateType: AGGREGATE_OF[input.eventName],
        aggregateId: input.aggregateId,
        eventName: input.eventName,
        topic: NOTIFICATION_TOPIC,
        payload,
        organizationId: input.organizationId,
        partitionKey,
        streamSeq,
        streamKey: partitionKey,
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
          // Taken from the row `buildOutboxRow` returned rather than from the
          // local variable, so the column and the envelope are the same value
          // by construction and cannot drift apart.
          streamSeq: row.streamSeq,
        },
      }),
    );

    return row.id;
  }
}
