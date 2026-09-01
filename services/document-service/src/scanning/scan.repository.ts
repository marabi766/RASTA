import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * The scan queue's persistence.
 *
 * Separate from `DocumentRepository` because the two answer to different
 * callers: that one serves requests that carry a tenant, and this one serves a
 * background worker that has none. Keeping them apart makes the crossing
 * visible — every query here runs unscoped, with a written reason, because a
 * worker scanning only its own organization's documents would scan nothing.
 *
 * ## Concurrency, in two mechanisms rather than one
 *
 * **`FOR UPDATE SKIP LOCKED` on the claim.** Two replicas polling at the same
 * instant take disjoint batches instead of serialising on the same rows. This
 * is what lets the worker scale past one instance at all.
 *
 * **A lease checked again on write-back.** `SKIP LOCKED` only holds for the
 * length of the claim transaction; the scan itself takes seconds, outside any
 * transaction. So the claim stamps an owner and an expiry, and every write-back
 * is conditional on still holding them. A worker that stalled past its lease
 * finds its update matches zero rows, and the verdict reached by whoever took
 * over stands. That is the property that makes a slow worker harmless rather
 * than a source of contradictory states.
 */
@Injectable()
export class ScanRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims up to `limit` documents for one worker.
   *
   * Claimable means: still `PENDING`, still `REGISTERED` (a document deleted
   * while queued is not worth scanning — nobody can reach it either way), due
   * by the retry schedule, and either unleased or holding an expired lease.
   *
   * Oldest first, so a backlog drains in the order it arrived rather than
   * starving whatever was unlucky enough to be queued during a spike.
   */
  async claim(input: {
    owner: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<ClaimedDocument[]> {
    // Raw SQL because Prisma has no expression for SKIP LOCKED, and the
    // correctness of concurrent scanning rests on it entirely.
    return runUnscoped(
      'the scan worker serves every tenant and belongs to none',
      () =>
        this.prisma.client.$queryRaw<ClaimedDocument[]>`
        UPDATE "document" AS d
           SET "scan_lease_owner" = ${input.owner},
               "scan_lease_expires_at" = now() + make_interval(secs => ${input.leaseSeconds}::double precision)
          FROM (
            SELECT "id"
              FROM "document"
             WHERE "scan_state" = 'PENDING'
               AND "status" = 'REGISTERED'
               AND ("scan_next_attempt_at" IS NULL OR "scan_next_attempt_at" <= now())
               AND ("scan_lease_expires_at" IS NULL OR "scan_lease_expires_at" <= now())
             ORDER BY COALESCE("scan_queued_at", "created_at")
             LIMIT ${input.limit}
             FOR UPDATE SKIP LOCKED
          ) AS due
         WHERE d."id" = due."id"
        RETURNING d."id"              AS "id",
                  d."organization_id" AS "organizationId",
                  d."object_key"      AS "objectKey",
                  d."content_type"    AS "contentType",
                  d."size_bytes"      AS "sizeBytes",
                  d."document_class"::text AS "documentClass",
                  d."scan_attempts"   AS "scanAttempts"
      `,
    );
  }

  /**
   * Writes a terminal verdict, if this worker still holds the lease.
   *
   * The `scan_state = 'PENDING'` predicate is not redundant with the lease. It
   * is what makes a duplicate delivery idempotent: a worker that scanned the
   * same document twice — a retry above the queue, a message replayed — finds
   * the second write matches nothing, so the verdict is recorded once and the
   * events that accompany it are enqueued once.
   *
   * Returns whether it won. The caller publishes events only if it did, which
   * is what keeps one scan from producing two `VIRUS_DETECTED` facts.
   */
  async completeIfHeld(
    tx: ExtendedPrismaClient,
    input: {
      documentId: string;
      owner: string;
      scanState: 'CLEAN' | 'INFECTED' | 'FAILED';
      engine: string;
      engineVersion: string | null;
      signatureVersion: string | null;
      signature: string | null;
      failureReason: string | null;
      quarantineReason: string | null;
      scannedAt: Date;
    },
  ): Promise<boolean> {
    const changed = await runUnscoped(
      'a scan verdict is written to the row it was reached for',
      () =>
        tx.document.updateMany({
          where: {
            id: input.documentId,
            scanState: 'PENDING',
            scanLeaseOwner: input.owner,
          },
          data: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            scanState: input.scanState as any,
            scanEngine: input.engine,
            scanVersion: input.engineVersion,
            scanSignatureVersion: input.signatureVersion,
            scanSignature: input.signature,
            scanFailureReason: input.failureReason,
            scannedAt: input.scannedAt,
            scanAttempts: { increment: 1 },
            // The quarantine record is written in the same statement as the
            // INFECTED state, never afterwards. `ck_document_infected_is_quarantined`
            // would refuse the row otherwise, which is the point: there is no
            // window in which a document is infected and undecided.
            quarantinedAt: input.quarantineReason ? input.scannedAt : null,
            quarantineReason: input.quarantineReason,
            // The claim is over either way.
            scanLeaseOwner: null,
            scanLeaseExpiresAt: null,
            scanNextAttemptAt: null,
          },
        }),
    );

    return changed.count === 1;
  }

  /**
   * Reschedules a retryable failure, if this worker still holds the lease.
   *
   * The state stays `PENDING`, which is what a caller sees and what
   * `canDownload` refuses. What changes is the bookkeeping: one more attempt
   * spent, the next one not before `nextAttemptAt`, and the lease released so
   * whichever replica is free then can take it.
   *
   * `scanFailureReason` is deliberately **not** written here. The column is
   * constrained to `FAILED` rows only, and a reason on a `PENDING` row would
   * read as a settled outcome to anybody filtering for problems. The reason a
   * retry happened belongs in the log and the metric, both of which record it.
   */
  async rescheduleIfHeld(
    tx: ExtendedPrismaClient,
    input: { documentId: string; owner: string; nextAttemptAt: Date },
  ): Promise<boolean> {
    const changed = await runUnscoped('a retry is scheduled on the document it belongs to', () =>
      tx.document.updateMany({
        where: {
          id: input.documentId,
          scanState: 'PENDING',
          scanLeaseOwner: input.owner,
        },
        data: {
          scanAttempts: { increment: 1 },
          scanNextAttemptAt: input.nextAttemptAt,
          scanLeaseOwner: null,
          scanLeaseExpiresAt: null,
        },
      }),
    );

    return changed.count === 1;
  }

  /**
   * Releases a claim without recording anything.
   *
   * For shutdown: a worker stopping mid-batch puts its unstarted documents
   * back rather than leaving them leased until expiry, so a rolling deploy
   * does not pause the queue for the length of a lease.
   */
  async releaseIfHeld(documentId: string, owner: string): Promise<void> {
    await runUnscoped('an unstarted claim is returned to the queue', () =>
      this.prisma.client.document.updateMany({
        where: { id: documentId, scanState: 'PENDING', scanLeaseOwner: owner },
        data: { scanLeaseOwner: null, scanLeaseExpiresAt: null },
      }),
    );
  }

  /** How many documents are waiting. Drives the pending-work gauge. */
  async pendingCount(): Promise<number> {
    return runUnscoped('the queue depth is a platform metric, not a tenant one', () =>
      this.prisma.client.document.count({
        where: { scanState: 'PENDING', status: 'REGISTERED' },
      }),
    );
  }

  /**
   * How long the oldest waiting document has waited, in seconds.
   *
   * The number that actually says whether scanning is keeping up. A queue depth
   * of ten is fine if they arrived a second ago and an incident if the oldest
   * has been there since yesterday.
   */
  async oldestPendingAgeSeconds(): Promise<number> {
    const rows = await runUnscoped(
      'the queue age is a platform metric, not a tenant one',
      () =>
        this.prisma.client.$queryRaw<{ age: number | null }[]>`
        SELECT EXTRACT(EPOCH FROM (now() - MIN(COALESCE("scan_queued_at", "created_at"))))::float8 AS age
          FROM "document"
         WHERE "scan_state" = 'PENDING' AND "status" = 'REGISTERED'
      `,
    );
    return rows[0]?.age ?? 0;
  }
}

export interface ClaimedDocument {
  readonly id: string;
  readonly organizationId: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly documentClass: string;
  readonly scanAttempts: number;
}
