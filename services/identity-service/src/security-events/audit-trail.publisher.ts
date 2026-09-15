import type { EventPublisher, OutboxRow } from '@rasta/nest-common';
import { assertPublishableAuditTrailRow } from './audit-trail-envelope';

/**
 * The broker port the refusal relay publishes through.
 *
 * Validates every row against the audit-trail contract, then hands the batch to
 * the same Kafka publisher the domain outbox uses (idempotent producer,
 * `acks=-1`, no topic auto-creation). A batch holding one invalid row throws
 * before anything is sent; the shared relay then retries row by row, so the
 * valid rows still go out and only the invalid one is scheduled for retry — and
 * never reaches the topic.
 */
export class AuditTrailPublisher implements EventPublisher {
  constructor(private readonly delegate: EventPublisher) {}

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) assertPublishableAuditTrailRow(row);
    await this.delegate.publish(rows);
  }
}
