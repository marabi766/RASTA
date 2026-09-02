import { Injectable } from '@nestjs/common';
import {
  claimPendingSql,
  markFailedSql,
  markPublishedSql,
  oldestPendingAgeSecondsSql,
  type OutboxRow,
  type OutboxStore,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Outbox persistence backed by this service's own database.
 *
 * The statements live in `@rasta/nest-common` because all eight services need
 * exactly the same ones; this class only binds them to this service's client.
 *
 * `claimPending` uses `FOR UPDATE SKIP LOCKED` so two replicas do not serialise
 * on the same row. That is all it does: the row lock ends with the statement's
 * own transaction, so it is **not** a durable reservation and two replicas can
 * still claim and publish the same row (D-026, ADR-050).
 */
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimPending(limit: number): Promise<OutboxRow[]> {
    return claimPendingSql(this.prisma.client, limit);
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    await markPublishedSql(this.prisma.client, ids, new Date());
  }

  async markFailed(id: string, error: string): Promise<void> {
    await markFailedSql(this.prisma.client, id, error);
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    return oldestPendingAgeSecondsSql(this.prisma.client);
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
