import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { AuditCorrectionAccepted } from './audit-correction.service';

/** One accepted correction command, as its replay protection stores it. */
export interface AuditCorrectionCommandRecord {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly targetId: string;
  readonly eventId: string;
  readonly responseBody: AuditCorrectionAccepted;
}

/**
 * `audit_correction_command` — the correction command's own idempotency state
 * (AUD-003 correction). See the migration for why this is not `idempotency_key`.
 *
 * Platform-scoped by design: the command is a `SYSTEM_ADMIN` command that may
 * target a record with no organization at all, so the table has no tenant
 * column and every access says so through `runUnscoped`. The key is the
 * verified actor plus the key they chose — never a tenant stand-in.
 */
@Injectable()
export class AuditCorrectionCommandRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    actorId: string,
    idempotencyKey: string,
  ): Promise<AuditCorrectionCommandRecord | null> {
    const row = await runUnscoped(
      'audit correction commands are platform-scoped SYSTEM_ADMIN commands with no tenant',
      () =>
        this.prisma.client.auditCorrectionCommand.findUnique({
          where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
        }),
    );
    return row === null
      ? null
      : {
          actorId: row.actorId,
          idempotencyKey: row.idempotencyKey,
          requestHash: row.requestHash,
          targetId: row.targetId,
          eventId: row.eventId,
          responseBody: row.responseBody as unknown as AuditCorrectionAccepted,
        };
  }

  /**
   * Records an accepted command inside the transaction that wrote its outbox
   * row. A concurrent duplicate fails here on the primary key and rolls its own
   * outbox row back with it.
   */
  async create(tx: ExtendedPrismaClient, record: AuditCorrectionCommandRecord): Promise<void> {
    await runUnscoped(
      'audit correction commands are platform-scoped SYSTEM_ADMIN commands with no tenant',
      () =>
        tx.auditCorrectionCommand.create({
          data: {
            actorId: record.actorId,
            idempotencyKey: record.idempotencyKey,
            requestHash: record.requestHash,
            targetId: record.targetId,
            eventId: record.eventId,
            responseBody: record.responseBody as unknown as object,
          },
        }),
    );
  }
}
