import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { Prisma, type NotificationIntent } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { newId, type IntentInput } from '../intake/intake';
import type { RenderedInApp } from '../rules/render';
import { DISCARD_REASONS } from '../observability/metrics';

/**
 * Every write this service makes, and the two invariants each one protects.
 *
 * **Ingest is one transaction.** The idempotency marker, the semantic dedupe
 * decision and the intent row commit together or not at all. A crash between
 * them would either notify twice or mark an event processed that produced
 * nothing, and the second is the one nobody notices (AGENTS.md A-09).
 *
 * **Dispatch is one fenced transaction.** The claim token taken by
 * `claimPending` is checked again inside the write that spends it. A worker
 * whose lease expired while it waited on identity-service finds its fence
 * refused, the transaction rolls back, and the worker that took the lease over
 * does the work instead — the ADR-050 shape, so the platform has one
 * concurrency pattern rather than two. The unique constraint on
 * `(intent, user, channel)` is the last line if both somehow reach the table.
 */

export const DISPATCHER_CONSUMER = 'notification-service.dispatcher';

/** What one ingestion attempt did. */
export type IngestOutcome =
  | { readonly kind: 'CREATED' }
  | { readonly kind: 'DUPLICATE_EVENT' }
  | { readonly kind: 'DEDUPED'; readonly seenCount: number }
  | { readonly kind: 'DISCARDED_STALE' };

export interface ResolvedRecipient {
  readonly userId: string;
  readonly role: string;
}

/** A render failure recorded against every delivery rather than any event. */
export interface RenderFailure {
  readonly errorClass: string;
}

/** Thrown when the fence refuses: another worker holds this intent now. */
export class LeaseLostError extends Error {
  constructor(readonly intentId: string) {
    super(`Lease on ${intentId} was lost before the write committed`);
    this.name = 'LeaseLostError';
  }
}

/** The channel this story delivers on. The enum holds nothing else yet. */
const IN_APP = 'IN_APP' as const;
/** In-app delivery is a database insert: one attempt, no retry ladder. */
const IN_APP_MAX_ATTEMPTS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bounds on the two transactions, stated rather than inherited.
 *
 * Prisma waits two seconds for a connection by default. A sweep burst hands
 * the consumer hundreds of envelopes in a row and the concurrency suite hands
 * it fifty at once; queueing for a pooled connection is the expected state in
 * both, not a fault, so the wait is widened. The transaction ceiling stays
 * well below the consumer's poll interval, so a genuinely stuck write fails
 * its poll and is retried by at-least-once delivery rather than holding a
 * connection indefinitely.
 */
const INGEST_TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;
const DISPATCH_TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;

@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Ingest — the consumer's write
  // =========================================================================

  /**
   * Runs inside the tenant context the consumer established from the
   * envelope, so every model write below is scoped by the guard and the raw
   * statements name the organization explicitly.
   */
  async ingest(intent: IntentInput, dedupeRetentionDays: number): Promise<IngestOutcome> {
    return this.prisma.transaction(async (tx) => {
      // Layer 1 — this exact message. ON CONFLICT rather than a catch: a
      // unique-violation aborts the whole transaction in PostgreSQL, and the
      // consumer needs "already done" to be a result, not an exception.
      const marked = await tx.$queryRaw<{ event_id: string }[]>`
        INSERT INTO "processed_event" ("event_id", "consumer_name")
        VALUES (${intent.sourceEventId}, ${DISPATCHER_CONSUMER})
        ON CONFLICT DO NOTHING
        RETURNING "event_id"
      `;
      if (marked.length === 0) return { kind: 'DUPLICATE_EVENT' };

      // Staleness guard (ADR-054 § 8). Cheap, and it needs no stream table:
      // if a later position on the same stream already produced an intent for
      // this subject, this event describes an older state of it.
      if (intent.sourceStreamSeq !== null && (await this.isStale(tx, intent))) {
        await tx.notificationIntent.create({
          data: {
            ...toIntentRow(intent),
            status: 'DISCARDED',
            terminalReason: DISCARD_REASONS.STALE_STREAM_SEQ,
            nextResolutionAt: null,
          },
        });
        return { kind: 'DISCARDED_STALE' };
      }

      // Layer 2 — the same fact. One statement decides "fresh window or
      // repeat" and, when the window has expired, reopens it for this intent.
      // The foreign key to the intent is deferred to commit, which is what
      // lets this run before the intent row exists.
      const expiresAt = new Date(Date.now() + dedupeRetentionDays * DAY_MS);
      const decided = await tx.$queryRaw<{ fresh: boolean; seen_count: number }[]>`
        INSERT INTO "notification_dedupe"
          ("dedupe_key", "organization_id", "intent_id", "first_seen_at", "last_seen_at", "seen_count", "expires_at")
        VALUES
          (${intent.dedupeKey}, ${intent.organizationId}, ${intent.id}, now(), now(), 1, ${expiresAt})
        ON CONFLICT ("dedupe_key") DO UPDATE SET
          "last_seen_at"  = now(),
          "seen_count"    = CASE WHEN "notification_dedupe"."expires_at" <= now()
                                 THEN 1 ELSE "notification_dedupe"."seen_count" + 1 END,
          "first_seen_at" = CASE WHEN "notification_dedupe"."expires_at" <= now()
                                 THEN now() ELSE "notification_dedupe"."first_seen_at" END,
          "intent_id"     = CASE WHEN "notification_dedupe"."expires_at" <= now()
                                 THEN EXCLUDED."intent_id" ELSE "notification_dedupe"."intent_id" END,
          "expires_at"    = CASE WHEN "notification_dedupe"."expires_at" <= now()
                                 THEN EXCLUDED."expires_at" ELSE "notification_dedupe"."expires_at" END
        RETURNING ("intent_id" = ${intent.id}) AS "fresh", "seen_count"
      `;

      const decision = decided[0];
      if (!decision) {
        throw new Error('The dedupe upsert returned no row, which ON CONFLICT DO UPDATE cannot do');
      }
      if (!decision.fresh) {
        return { kind: 'DEDUPED', seenCount: decision.seen_count };
      }

      await tx.notificationIntent.create({
        data: {
          ...toIntentRow(intent),
          status: 'PENDING',
          // Null means "due now". The worker's clock is the database's, never
          // this process's: a host clock a few tens of milliseconds ahead of
          // PostgreSQL (PROJECT_MEMORY § 30) would otherwise leave a fresh
          // intent invisible to the next tick.
          nextResolutionAt: null,
        },
      });
      return { kind: 'CREATED' };
    }, INGEST_TRANSACTION);
  }

  private async isStale(tx: ExtendedPrismaClient, intent: IntentInput): Promise<boolean> {
    const rows = await tx.$queryRaw<{ max_seq: bigint | null }[]>`
      SELECT max("source_stream_seq") AS "max_seq"
        FROM "notification_intent"
       WHERE "organization_id" = ${intent.organizationId}
         AND "source_topic" = ${intent.sourceTopic}
         AND "source_partition_key" = ${intent.sourcePartitionKey}
         AND "subject_id" = ${intent.subjectId}
    `;
    const maxSeq = rows[0]?.max_seq ?? null;
    return maxSeq !== null && intent.sourceStreamSeq !== null && maxSeq > intent.sourceStreamSeq;
  }

  // =========================================================================
  // Resolution worker — claim, defer, suppress, dispatch
  // =========================================================================

  /**
   * Leases up to `batchSize` due intents to `owner` for `leaseSeconds`.
   *
   * `FOR UPDATE SKIP LOCKED` makes concurrent workers pick disjoint rows; the
   * lease makes the pick survive the transaction, which a row lock alone does
   * not (D-026). A row whose lease expired is claimable again — that is how a
   * crashed worker's work is picked up.
   *
   * Runs across every tenant by construction: the worker has no tenant until
   * it has a row. Each claimed intent is then processed inside its own
   * organization's context, and the guard scopes everything from there.
   */
  async claimPending(
    owner: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<NotificationIntent[]> {
    return runUnscoped(
      'the resolution worker claims due intents across tenants; each is processed in its own tenant context',
      async () => {
        const claimed = await this.prisma.client.$queryRaw<{ id: string }[]>`
          WITH "candidates" AS (
            SELECT "id"
              FROM "notification_intent"
             WHERE "status" = 'PENDING'
               AND ("next_resolution_at" IS NULL OR "next_resolution_at" <= now())
               AND ("claim_expires_at" IS NULL OR "claim_expires_at" <= now())
             ORDER BY "next_resolution_at" ASC NULLS FIRST, "created_at" ASC
             LIMIT ${batchSize}
               FOR UPDATE SKIP LOCKED
          )
          UPDATE "notification_intent" AS "i"
             SET "claim_token"      = gen_random_uuid()::text,
                 "claim_owner"      = ${owner},
                 "claim_expires_at" = now() + make_interval(secs => ${leaseSeconds}),
                 "updated_at"       = now()
            FROM "candidates"
           WHERE "i"."id" = "candidates"."id"
          RETURNING "i"."id"
        `;
        if (claimed.length === 0) return [];
        return this.prisma.client.notificationIntent.findMany({
          where: { id: { in: claimed.map((row) => row.id) } },
          orderBy: [{ nextResolutionAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        });
      },
    );
  }

  /**
   * Hands a claimed intent back for a later attempt. Fenced: a worker that
   * lost its lease changes nothing.
   */
  async deferResolution(
    intent: Pick<NotificationIntent, 'id' | 'claimToken'>,
    errorClass: string,
    nextResolutionAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.client.notificationIntent.updateMany({
      where: { id: intent.id, claimToken: intent.claimToken, status: 'PENDING' },
      data: {
        resolutionAttempts: { increment: 1 },
        lastResolutionError: errorClass,
        nextResolutionAt,
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /** Terminal, by decision: nobody is entitled, and the row says so. */
  async suppress(
    intent: Pick<NotificationIntent, 'id' | 'claimToken'>,
    reason: string,
  ): Promise<boolean> {
    const result = await this.prisma.client.notificationIntent.updateMany({
      where: { id: intent.id, claimToken: intent.claimToken, status: 'PENDING' },
      data: {
        status: 'SUPPRESSED',
        terminalReason: reason,
        resolvedAt: new Date(),
        nextResolutionAt: null,
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /**
   * The dispatch write for the in-app channel: snapshot, deliveries, attempts
   * and the rows a person sees, in one transaction fenced on the claim.
   *
   * For `IN_APP` the delivery *is* the insert, so each delivery is written
   * already `SENT` with its one `SUCCESS` attempt — invariant 1 holds on the
   * row from the moment it exists. A render failure writes every delivery
   * `FAILED` with a `PERMANENT_FAILURE` attempt instead and no in-app row: the
   * event was fine, the template was not, and the record says exactly that
   * (ADR-054 § 9).
   */
  async dispatchInApp(input: {
    intent: NotificationIntent;
    recipients: readonly ResolvedRecipient[];
    rendered: RenderedInApp | RenderFailure;
    templateVersion: number;
    inAppTtlDays: number;
  }): Promise<{ deliveries: number; inApp: number }> {
    const { intent, recipients, rendered } = input;
    const now = new Date();
    const failure = 'errorClass' in rendered ? rendered : null;
    const content = 'errorClass' in rendered ? null : rendered;

    return this.prisma.transaction(async (tx) => {
      const fenced = await tx.notificationIntent.updateMany({
        where: { id: intent.id, claimToken: intent.claimToken, status: 'PENDING' },
        data: {
          status: 'DISPATCHED',
          resolvedAt: now,
          dispatchedAt: now,
          nextResolutionAt: null,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (fenced.count !== 1) throw new LeaseLostError(intent.id);

      const resolutions: Prisma.RecipientResolutionCreateManyInput[] = [];
      const deliveries: Prisma.NotificationDeliveryCreateManyInput[] = [];
      const attempts: Prisma.DeliveryAttemptCreateManyInput[] = [];
      const inApp: Prisma.InAppNotificationCreateManyInput[] = [];

      for (const recipient of recipients) {
        const deliveryId = newId('delivery');

        resolutions.push({
          id: newId('resolution'),
          intentId: intent.id,
          organizationId: intent.organizationId,
          userId: recipient.userId,
          resolvedRole: recipient.role,
          resolvedAt: now,
          resolutionSource: 'IDENTITY_API',
        });

        deliveries.push({
          id: deliveryId,
          intentId: intent.id,
          organizationId: intent.organizationId,
          userId: recipient.userId,
          channel: IN_APP,
          status: failure ? 'FAILED' : 'SENT',
          templateKey: intent.templateKey,
          templateVersion: input.templateVersion,
          attemptCount: 1,
          maxAttempts: IN_APP_MAX_ATTEMPTS,
          lastErrorClass: failure ? failure.errorClass : null,
          sentAt: failure ? null : now,
        });

        attempts.push({
          id: newId('attempt'),
          deliveryId,
          organizationId: intent.organizationId,
          attemptNo: 1,
          outcome: failure ? 'PERMANENT_FAILURE' : 'SUCCESS',
          errorClass: failure ? failure.errorClass : null,
          startedAt: now,
          finishedAt: now,
        });

        if (content) {
          inApp.push({
            id: newId('inApp'),
            deliveryId,
            intentId: intent.id,
            organizationId: intent.organizationId,
            userId: recipient.userId,
            ruleKey: intent.ruleKey,
            severity: intent.severity,
            classification: intent.classification,
            subjectType: intent.subjectType,
            subjectId: intent.subjectId,
            title: content.title,
            body: content.body,
            actionPath: content.actionPath,
            occurredAt: intent.occurredAt,
            expiresAt: new Date(now.getTime() + input.inAppTtlDays * DAY_MS),
          });
        }
      }

      if (resolutions.length > 0) {
        await tx.recipientResolution.createMany({ data: resolutions });
        await tx.notificationDelivery.createMany({ data: deliveries });
        await tx.deliveryAttempt.createMany({ data: attempts });
      }
      if (inApp.length > 0) {
        await tx.inAppNotification.createMany({ data: inApp });
      }

      return { deliveries: deliveries.length, inApp: inApp.length };
    }, DISPATCH_TRANSACTION);
  }

  // =========================================================================
  // Sampled gauges
  // =========================================================================

  async pendingSummary(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.prisma.client.$queryRaw<
      { pending: bigint; oldest_age_seconds: number | null }[]
    >`
      SELECT count(*) AS "pending",
             EXTRACT(EPOCH FROM (now() - min("created_at")))::float8 AS "oldest_age_seconds"
        FROM "notification_intent"
       WHERE "status" = 'PENDING'
    `;
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestAgeSeconds: row?.oldest_age_seconds ?? 0,
    };
  }
}

function toIntentRow(intent: IntentInput): Prisma.NotificationIntentCreateInput {
  return {
    id: intent.id,
    organizationId: intent.organizationId,
    sourceEventId: intent.sourceEventId,
    sourceEventName: intent.sourceEventName,
    sourceTopic: intent.sourceTopic,
    sourcePartitionKey: intent.sourcePartitionKey,
    sourceStreamSeq: intent.sourceStreamSeq,
    occurredAt: intent.occurredAt,
    correlationId: intent.correlationId,
    causationId: intent.causationId,
    ruleKey: intent.ruleKey,
    templateKey: intent.templateKey,
    severity: intent.severity,
    classification: intent.classification,
    subjectType: intent.subjectType,
    subjectId: intent.subjectId,
    dedupeKey: intent.dedupeKey,
    contextData: intent.contextData as Prisma.InputJsonValue,
  };
}
