import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  activeLeaseCountSql,
  claimPendingSql,
  markFailedSql,
  markPublishedSql,
  oldestPendingAgeSecondsSql,
  purgePublishedSql,
  releaseSql,
  renewSql,
  type ClaimRequest,
  type OutboxClaim,
  type OutboxPurgeStore,
  type OutboxStore,
  type PurgePublishedBatch,
  type PurgePublishedOptions,
  type RetryBackoff,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Outbox persistence backed by this service's own database.
 *
 * The statements live in `@rasta/nest-common` because every service needs
 * exactly the same ones; this class binds them to this service's client and
 * mints the fencing token. Nothing here is service-specific, and nothing here
 * may become service-specific: a simplified or locally-tuned claim protocol is
 * exactly the divergence ADR-050 was written to end.
 *
 * A fresh, unguessable token per claim attempt is the whole mechanism
 * (ADR-050). `claim_owner` records which process holds a row and is read by
 * nobody making a decision; `claim_expires_at` says only when somebody else
 * may take the row back. Neither is a fence — the first draft of ADR-050
 * proposed both and was wrong on both counts.
 */
@Injectable()
export class PrismaOutboxStore implements OutboxStore, OutboxPurgeStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimPending(request: ClaimRequest): Promise<OutboxClaim> {
    return claimPendingSql(this.prisma.client, {
      limit: request.limit,
      // A new token every attempt. The same process claiming twice must not be
      // able to acknowledge its first claim with its second token, which is
      // exactly what a process-scoped owner id would have allowed.
      token: randomUUID(),
      owner: request.owner,
      leaseSeconds: request.leaseSeconds,
    });
  }

  async markPublished(ids: readonly string[], token: string): Promise<number> {
    return markPublishedSql(this.prisma.client, ids, token);
  }

  async markFailed(
    id: string,
    token: string,
    error: string,
    backoff: RetryBackoff,
  ): Promise<number> {
    return markFailedSql(this.prisma.client, id, token, error, backoff);
  }

  async release(ids: readonly string[], token: string, deadlineMs: number): Promise<number> {
    return releaseSql(
      (fn, timeoutMs) =>
        this.prisma.client.$transaction(fn, { timeout: timeoutMs, maxWait: timeoutMs }),
      ids,
      token,
      deadlineMs,
    );
  }

  async renew(
    ids: readonly string[],
    token: string,
    leaseSeconds: number,
    deadlineMs: number,
  ): Promise<string[]> {
    return renewSql(
      (fn, timeoutMs) =>
        this.prisma.client.$transaction(fn, { timeout: timeoutMs, maxWait: timeoutMs }),
      ids,
      token,
      leaseSeconds,
      deadlineMs,
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    return oldestPendingAgeSecondsSql(this.prisma.client);
  }

  async pendingCount(): Promise<number> {
    return this.prisma.client.outboxMessage.count({ where: { publishedAt: null } });
  }

  /** Rows under a live lease right now. Sampled for the gauge, never inferred. */
  async activeLeaseCount(): Promise<number> {
    return activeLeaseCountSql(this.prisma.client);
  }

  /**
   * Deletes one bounded batch of published rows older than the retention, for
   * `OutboxPurgeScheduler` (D-052).
   *
   * Only published rows, and only old ones: an unpublished row is an event
   * that has not reached anybody yet, and deleting it would lose it silently.
   * `ck_outbox_published_is_clean` guarantees a published row holds no live
   * claim, so this can never delete a row somebody is still publishing. The
   * limit, the timeouts and the replica lock are in `purgePublishedSql`.
   *
   * The wait for a connection and the transaction are bounded separately
   * (`OUTBOX_PURGE_MAX_WAIT_MS`, then the statement timeout plus its margin),
   * and their sum is what `loadEnv` holds under SHUTDOWN_TIMEOUT_MS.
   */
  async purgePublished(options: PurgePublishedOptions): Promise<PurgePublishedBatch> {
    return purgePublishedSql(
      (fn, { timeoutMs, maxWaitMs }) =>
        this.prisma.client.$transaction(fn, { timeout: timeoutMs, maxWait: maxWaitMs }),
      options,
    );
  }
}
