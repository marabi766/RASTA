import { Injectable } from '@nestjs/common';
import type { OutboxRow, OutboxStore } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Outbox persistence backed by this service's own database.
 *
 * The interesting part is {@link claimPending}: it uses
 * `FOR UPDATE SKIP LOCKED`, which lets several service replicas relay
 * concurrently without any of them publishing the same row twice. Without
 * `SKIP LOCKED`, replicas would serialise on the same rows and the relay would
 * scale to exactly one instance.
 */
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimPending(limit: number): Promise<OutboxRow[]> {
    // Raw SQL because Prisma has no expression for SKIP LOCKED, and the whole
    // correctness of concurrent relaying rests on it.
    const rows = await this.prisma.client.$queryRaw<RawOutboxRow[]>`
      SELECT id, aggregate_type, aggregate_id, event_name, event_version,
             topic, partition_key, payload, headers, organization_id,
             correlation_id, created_at, published_at, attempts, last_error
      FROM outbox_message
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    return rows.map(toOutboxRow);
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.client.outboxMessage.updateMany({
      where: { id: { in: [...ids] } },
      data: { publishedAt: new Date() },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.client.outboxMessage.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const result = await this.prisma.client.$queryRaw<{ age: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS age
      FROM outbox_message
      WHERE published_at IS NULL
    `;
    return result[0]?.age ?? 0;
  }

  async pendingCount(): Promise<number> {
    return this.prisma.client.outboxMessage.count({ where: { publishedAt: null } });
  }

  /**
   * Deletes published rows older than `retentionDays`.
   *
   * Only published rows, and only old ones: an unpublished row is an event
   * that has not reached anybody yet, and deleting it would lose it silently.
   */
  async purgePublished(retentionDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.client.outboxMessage.deleteMany({
      where: { publishedAt: { not: null, lt: cutoff } },
    });
    return result.count;
  }
}

interface RawOutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  event_version: number;
  topic: string;
  partition_key: string;
  payload: unknown;
  headers: unknown;
  organization_id: string | null;
  correlation_id: string;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

function toOutboxRow(row: RawOutboxRow): OutboxRow {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventName: row.event_name,
    eventVersion: row.event_version,
    topic: row.topic,
    partitionKey: row.partition_key,
    payload: row.payload,
    headers: (row.headers ?? {}) as Record<string, string>,
    organizationId: row.organization_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}
