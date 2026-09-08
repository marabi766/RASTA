import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import type { AuditEventRecord } from './audit.mapper';

/** What one ingestion attempt did. */
export type IngestOutcome = 'WRITTEN' | 'DUPLICATE';

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes the audit row and its idempotency marker in one transaction.
   *
   * The ordering matters and is asserted by a test: the audit row goes in
   * first, then `processed_event`. Both are in the same transaction, so the
   * outcome is all-or-nothing — but if that ever changed, an event marked
   * processed without its evidence is the failure that loses records silently,
   * while evidence without the marker merely produces a duplicate attempt that
   * the unique index refuses. One direction is recoverable; the other is not
   * (AGENTS.md A-09, ADR-053 § 8).
   *
   * `organization_ref` is upserted in the same transaction so a query in
   * AUD-002 can list the tenants it may scope to without a cross-service call.
   * It is a projection of an identifier this service already holds — never a
   * copy of organization-service's rows (A-01).
   *
   * Duplicate delivery is a no-op rather than an error. Kafka is at-least-once
   * and `fromBeginning: true` means a rebalance can replay the whole log, so a
   * second delivery is normal operation, not a fault.
   */
  async ingest(record: AuditEventRecord, consumerName: string): Promise<IngestOutcome> {
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        // Checked inside the transaction, not before it. A check outside would
        // be a race: two workers rebalancing onto the same partition could both
        // see "not processed" and both proceed, and only the unique index would
        // stop them.
        const already = await tx.processedEvent.findUnique({
          where: {
            eventId_consumerName: { eventId: record.sourceEventId, consumerName },
          },
          select: { eventId: true },
        });
        if (already) return 'DUPLICATE';

        await tx.auditEvent.create({
          data: {
            id: record.id,
            occurredAt: record.occurredAt,
            actorType: record.actorType,
            actorId: record.actorId,
            actorRoles: record.actorRoles,
            organizationId: record.organizationId,
            action: record.action,
            resourceType: record.resourceType,
            resourceId: record.resourceId,
            outcome: record.outcome,
            occurrenceCount: record.occurrenceCount,
            sourceService: record.sourceService,
            sourceServiceVersion: record.sourceServiceVersion,
            sourceEventId: record.sourceEventId,
            sourceEventName: record.sourceEventName,
            sourceTopic: record.sourceTopic,
            correlationId: record.correlationId,
            causationId: record.causationId,
            traceparent: record.traceparent,
            sourceStreamSeq: record.sourceStreamSeq,
            // recordedAt is left to the database default on purpose: the gap
            // between it and occurredAt is consumer lag, and a value chosen
            // here would measure this process's clock instead.
          },
        });

        await tx.processedEvent.create({
          data: { eventId: record.sourceEventId, consumerName },
        });

        if (record.organizationId !== null) {
          await tx.organizationRef.upsert({
            where: { organizationId: record.organizationId },
            create: { organizationId: record.organizationId },
            update: { lastSeenAt: new Date() },
          });
        }

        return 'WRITTEN';
      });
    } catch (error) {
      // P2002 is the unique index doing its job: the same event arriving on the
      // same topic twice, close enough together that both transactions passed
      // the check above. The row that exists is the row we would have written,
      // so this is a duplicate, not a failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'DUPLICATE';
      }
      throw error;
    }
  }

  /**
   * Approximate rows per partition, for the capacity gauge.
   *
   * `reltuples` from the catalogue rather than `count(*)`: an exact count over
   * a growing append-only table is a sequential scan per partition per scrape,
   * which would make the metric the most expensive query this service runs.
   * Capacity planning does not need the last thousand rows.
   */
  async partitionRowCounts(): Promise<{ partition: string; rows: number }[]> {
    const rows = await this.prisma.client.$queryRaw<{ partition: string; rows: number }[]>`
      SELECT c.relname AS partition,
             GREATEST(c.reltuples, 0)::float8 AS rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'audit_event'
         AND n.nspname = current_schema()
    `;
    return rows.map((row) => ({ partition: row.partition, rows: Number(row.rows) }));
  }
}
