import { createHash } from 'node:crypto';
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
 * Names the advisory-lock key space of this one command, so the key can never
 * equal one hashed for any other purpose. Versioned: changing the encoding
 * below means a new version, because old and new instances running side by
 * side must derive the same key to exclude each other.
 */
export const COMMAND_LOCK_NAMESPACE = 'identity-service:audit_correction_command:v1';

/**
 * The signed 64-bit advisory-lock key for one `(actorId, idempotencyKey)`.
 *
 * The tuple is encoded as a JSON array, where every element is quoted and
 * escaped, so no two distinct tuples share an encoding (`("a:b", "c")` and
 * `("a", "b:c")` differ). The first eight bytes of its SHA-256 are the key. Two
 * distinct tuples can still collide on 64 bits; that only makes two unrelated
 * commands wait for each other, because the decision itself is always the
 * re-read of the exact `(actorId, idempotencyKey)` row.
 */
export function commandLockKey(actorId: string, idempotencyKey: string): bigint {
  return createHash('sha256')
    .update(JSON.stringify([COMMAND_LOCK_NAMESPACE, actorId, idempotencyKey]), 'utf8')
    .digest()
    .readBigInt64BE(0);
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

  /**
   * The stored command for `(actorId, idempotencyKey)`, if any.
   *
   * Pass `tx` to read inside the write transaction — after `lockCommandKey`,
   * that read is the one the decision to write rests on.
   */
  async find(
    actorId: string,
    idempotencyKey: string,
    tx?: ExtendedPrismaClient,
  ): Promise<AuditCorrectionCommandRecord | null> {
    const db = tx ?? this.prisma.client;
    const row = await runUnscoped(
      'audit correction commands are platform-scoped SYSTEM_ADMIN commands with no tenant',
      () =>
        db.auditCorrectionCommand.findUnique({
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
   * Serialises every attempt at one command, inside the caller's transaction.
   *
   * A PostgreSQL transaction-scoped advisory lock on `commandLockKey`: held
   * until the transaction commits or rolls back, never beyond it, and no row
   * is written. Taken before the in-transaction re-read, so a concurrent
   * duplicate waits here — not behind the outbox stream counter — and then
   * sees the winner's committed record under READ COMMITTED. The key is a
   * bound parameter; nothing is interpolated into the statement.
   */
  async lockCommandKey(
    tx: ExtendedPrismaClient,
    actorId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const lockKey = commandLockKey(actorId, idempotencyKey);
    // `$executeRaw`, not `$queryRaw`: the function returns `void`, which has
    // no row value to deserialise.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
  }

  /**
   * Records an accepted command inside the transaction that wrote its outbox
   * row. The primary key stays the last line of defence: a writer that does
   * not follow the `lockCommandKey` protocol fails here and rolls its own
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
