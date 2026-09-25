import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { Prisma, type NotificationIntent } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { newId, type IntentInput } from '../intake/intake';
import type { RenderedInApp } from '../rules/render';
import { applyQuietHours } from '../channels/quiet-hours';
import { DISCARD_REASONS, SUPPRESSION_REASONS } from '../observability/metrics';
import {
  resolvePreference,
  type ChannelDefaults,
  type PreferenceRow,
  type RuleFacts,
} from '../preferences/precedence';

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
  /** Snapshotted at resolution time; null when identity holds no address. */
  readonly email: string | null;
}

/** A render failure recorded against every delivery rather than any event. */
export interface RenderFailure {
  readonly errorClass: string;
}

/**
 * What one dispatch wrote, counted per channel.
 *
 * Deliberately not one `suppressed` number across both channels: a person who
 * turned email off and still has their in-app notification is one suppression
 * and one delivery, and a single counter makes that indistinguishable from
 * somebody who received nothing at all.
 */
export interface DispatchSummary {
  /** Every delivery row written, both channels, whatever their status. */
  readonly deliveries: number;
  /** In-app rows a person can actually see. */
  readonly inApp: number;
  readonly inAppSuppressed: number;
  readonly emailQueued: number;
  readonly emailSuppressed: number;
  /** Of the queued ones, how many wait for a quiet window to end. */
  readonly emailDeferred: number;
}

/**
 * One email delivery, with everything the sender needs and nothing else.
 *
 * Flat and joined at claim time rather than loaded through relations: the
 * worker holds a lease while it works, and three round trips per message is
 * three chances for the lease to expire mid-send.
 */
export interface SendableDelivery {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly intentId: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly claimToken: string;
  /** From the resolution snapshot. Null only if the snapshot itself is missing. */
  readonly email: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly ruleKey: string;
  readonly contextData: unknown;
  readonly correlationId: string;
}

/** Thrown when the fence refuses: another worker holds this intent now. */
export class LeaseLostError extends Error {
  constructor(readonly intentId: string) {
    super(`Lease on ${intentId} was lost before the write committed`);
    this.name = 'LeaseLostError';
  }
}

const IN_APP = 'IN_APP' as const;
const EMAIL = 'EMAIL' as const;
/** In-app delivery is a database insert: one attempt, no retry ladder. */
const IN_APP_MAX_ATTEMPTS = 1;
/**
 * Six attempts for email: the five waits of ADR-054 § 7 — 1s, 5s, 30s, 2m,
 * 10m — and the attempt each one leads to. `ck_delivery_dead_exhausted`
 * refuses a `DEAD` row before they are spent, so this number and that ladder
 * cannot drift apart without the database saying so.
 */
export const EMAIL_MAX_ATTEMPTS = 6;

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
      // `last_seen_at` is written as a running maximum, not as a bare `now()`.
      //
      // `now()` is `transaction_timestamp()`: fixed when the transaction
      // began, constant for its whole life, and unrelated to when this
      // statement actually runs. Conflicting ingests serialize on
      // `dedupe_key` in commit order, which is not the order they began in,
      // so a transaction that began earlier can reach `DO UPDATE` after a
      // later one has already inserted the row — writing a `last_seen_at`
      // that precedes the `first_seen_at` beside it and tripping
      // `ck_dedupe_window_ordered` (SQLSTATE 23514).
      //
      // `GREATEST` makes the invariant hold by construction in both branches,
      // without assuming the clock moves forward:
      //   repeat  `first_seen_at` is unchanged, and the stored
      //           `last_seen_at` already dominates it, so the maximum does too.
      //   reopen  `first_seen_at` becomes `now()`, which the maximum
      //           dominates by definition.
      // That independence from clock monotonicity is why this is preferred to
      // `clock_timestamp()`, which would also be re-evaluated separately in
      // each of the four window tests below and could decide them
      // inconsistently.
      //
      // Separately, and deliberately left alone here: `expiresAt` below is the
      // *application* clock, while the window test (`expires_at <= now()`) and
      // the constraint's second half (`first_seen_at < expires_at`) read the
      // *database* clock. The two only disagree by clock skew, and
      // NOTIFICATION_DEDUPE_RETENTION_DAYS is an integer of at least 1, so a
      // violation would need the application to be a full day behind the
      // database. That is a latent coupling, not this defect — the row that
      // failed had seen_count 2, the repeat branch, which does not write
      // `expires_at` at all. Computing it in SQL would remove the coupling and
      // is worth doing on its own, with its own tests.
      const expiresAt = new Date(Date.now() + dedupeRetentionDays * DAY_MS);
      const decided = await tx.$queryRaw<{ fresh: boolean; seen_count: number }[]>`
        INSERT INTO "notification_dedupe"
          ("dedupe_key", "organization_id", "intent_id", "first_seen_at", "last_seen_at", "seen_count", "expires_at")
        VALUES
          (${intent.dedupeKey}, ${intent.organizationId}, ${intent.id}, now(), now(), 1, ${expiresAt})
        ON CONFLICT ("dedupe_key") DO UPDATE SET
          -- GREATEST, not bare now() -- see the note above this statement.
          "last_seen_at"  = GREATEST("notification_dedupe"."last_seen_at", now()),
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
   * The dispatch write: snapshot, deliveries, attempts and the rows a person
   * sees, in one transaction fenced on the claim.
   *
   * The two channels leave this transaction in different states, and that
   * asymmetry is the design rather than an accident of implementation.
   *
   *   `IN_APP`  the delivery *is* the insert, so the row is written already
   *             `SENT` with its one `SUCCESS` attempt — invariant 1 holds from
   *             the moment it exists. A render failure writes `FAILED` with a
   *             `PERMANENT_FAILURE` attempt and no in-app row: the event was
   *             fine and the template was not (ADR-054 § 9).
   *   `EMAIL`   the row is written `QUEUED` with zero attempts and a due time.
   *             Nothing is sent here. A mail server is a remote party with its
   *             own latency and its own outages, and holding a database
   *             transaction open across one is how a slow provider becomes a
   *             connection-pool outage (ADR § 7).
   *
   * Quiet hours are applied here rather than at send time because the decision
   * belongs with the row: `scheduledFor` records *why* a delivery is not due
   * yet, and the worker re-checks the window before it sends anyway.
   */
  async dispatch(input: {
    intent: NotificationIntent;
    recipients: readonly ResolvedRecipient[];
    rendered: RenderedInApp | RenderFailure;
    templateVersion: number;
    inAppTtlDays: number;
    /**
     * What the preference ladder needs to know about the rule that fired
     * (NTF-003, ADR-054 § 5). Passed in rather than looked up here, so this
     * repository stays a writer and the rule catalogue stays the caller's.
     */
    rule: RuleFacts;
    /** The channel defaults of ADR-054 § 5 — configuration, not a constant. */
    channelDefaults: ChannelDefaults;
    /**
     * The email text this rule renders, or null when it has none.
     *
     * Null is not "skip email": it writes a suppressed row naming
     * `NO_EMAIL_TEMPLATE`, because a rule added without email text would
     * otherwise produce a silence indistinguishable from an outage.
     */
    emailTemplate: { key: string; version: number } | null;
  }): Promise<DispatchSummary> {
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
      let inAppSuppressed = 0;
      let emailSuppressed = 0;
      let emailQueued = 0;
      let emailDeferred = 0;

      const userIds = recipients.map((recipient) => recipient.userId);

      // One read for the whole dispatch rather than one per recipient per
      // layer. Preferences are per tenant, so this is already scoped to the
      // intent's organization by the guard as well as by the predicate. Both
      // channels are read in the same statement: the ladder filters by channel
      // itself, and two queries would be two round trips for one decision.
      const preferenceRows = await tx.notificationPreference.findMany({
        where: { organizationId: intent.organizationId, userId: { in: userIds } },
        select: { userId: true, scope: true, scopeKey: true, channel: true, enabled: true },
      });
      const preferencesByUser = new Map<string, PreferenceRow[]>();
      for (const stored of preferenceRows) {
        const own = preferencesByUser.get(stored.userId) ?? [];
        own.push(stored);
        preferencesByUser.set(stored.userId, own);
      }

      // Quiet windows, read once for the same reason.
      const quietRows = await tx.notificationQuietHours.findMany({
        where: { organizationId: intent.organizationId, userId: { in: userIds } },
        select: { userId: true, startMinute: true, endMinute: true, timezone: true },
      });
      const quietByUser = new Map(quietRows.map((row) => [row.userId, row]));

      for (const recipient of recipients) {
        const deliveryId = newId('delivery');

        // The resolution is written whichever way the ladder falls. It records
        // that this person *was* entitled to the notification, which stays true
        // even when they have asked not to receive it — and without it a
        // suppressed delivery would have no explanation of why it existed.
        resolutions.push({
          id: newId('resolution'),
          intentId: intent.id,
          organizationId: intent.organizationId,
          userId: recipient.userId,
          resolvedRole: recipient.role,
          // Snapshotted at resolution, never read again from identity: a
          // message has to be answerable for where it went, and an address
          // looked up at send time answers a different question than the one
          // the notification was resolved against (ADR-054 § 2).
          emailSnapshot: recipient.email,
          resolvedAt: now,
          resolutionSource: 'IDENTITY_API',
        });

        // --- the email half, decided but not sent -------------------------
        const emailDecision = resolvePreference(
          preferencesByUser.get(recipient.userId) ?? [],
          input.rule,
          EMAIL,
          input.channelDefaults,
        );
        const emailSuppression = !emailDecision.enabled
          ? emailDecision.suppressionReason
          : !input.emailTemplate
            ? SUPPRESSION_REASONS.NO_EMAIL_TEMPLATE
            : !recipient.email
              ? SUPPRESSION_REASONS.NO_ADDRESS
              : null;

        const emailDeliveryId = newId('delivery');
        if (emailSuppression) {
          emailSuppressed += 1;
          deliveries.push({
            id: emailDeliveryId,
            intentId: intent.id,
            organizationId: intent.organizationId,
            userId: recipient.userId,
            channel: EMAIL,
            status: 'SUPPRESSED',
            templateKey: input.emailTemplate?.key ?? intent.templateKey,
            templateVersion: input.emailTemplate?.version ?? input.templateVersion,
            attemptCount: 0,
            maxAttempts: EMAIL_MAX_ATTEMPTS,
            suppressionReason: emailSuppression,
          });
        } else {
          const quiet = quietByUser.get(recipient.userId);
          const { scheduledFor, deferred } = applyQuietHours(
            now,
            intent.severity,
            quiet
              ? {
                  startMinute: quiet.startMinute,
                  endMinute: quiet.endMinute,
                  timezone: quiet.timezone,
                }
              : null,
          );
          if (deferred) emailDeferred += 1;
          emailQueued += 1;

          deliveries.push({
            id: emailDeliveryId,
            intentId: intent.id,
            organizationId: intent.organizationId,
            userId: recipient.userId,
            channel: EMAIL,
            status: 'QUEUED',
            // `input.emailTemplate` is non-null here: a null one produced a
            // suppressed row above.
            templateKey: (input.emailTemplate as { key: string; version: number }).key,
            templateVersion: (input.emailTemplate as { key: string; version: number }).version,
            attemptCount: 0,
            maxAttempts: EMAIL_MAX_ATTEMPTS,
            scheduledFor,
            nextAttemptAt: scheduledFor ?? now,
          });
        }

        // --- the in-app half, decided and delivered in the same breath -----
        const decision = resolvePreference(
          preferencesByUser.get(recipient.userId) ?? [],
          input.rule,
          IN_APP,
          input.channelDefaults,
        );

        if (!decision.enabled) {
          // Suppression is a decision, not a failure: zero attempts, a bounded
          // reason, and no in-app row (`ck_delivery_suppressed_shape`). The row
          // exists so the person can be told *why* nothing arrived, which is
          // the difference between a preference system and a silent drop.
          inAppSuppressed += 1;
          deliveries.push({
            id: deliveryId,
            intentId: intent.id,
            organizationId: intent.organizationId,
            userId: recipient.userId,
            channel: IN_APP,
            status: 'SUPPRESSED',
            templateKey: intent.templateKey,
            templateVersion: input.templateVersion,
            attemptCount: 0,
            maxAttempts: IN_APP_MAX_ATTEMPTS,
            suppressionReason: decision.suppressionReason,
          });
          continue;
        }

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

      return {
        deliveries: deliveries.length,
        inApp: inApp.length,
        inAppSuppressed,
        emailQueued,
        emailSuppressed,
        emailDeferred,
      };
    }, DISPATCH_TRANSACTION);
  }

  // =========================================================================
  // The email queue (NTF-004)
  // =========================================================================

  /**
   * Claims email deliveries that are due, across every tenant.
   *
   * The same shape as `claimPending` and for the same reasons (ADR-050): a
   * durable lease rather than a row lock, so the claim survives the
   * transaction and a crashed worker's rows become claimable again when the
   * lease runs out. `SENDING` is claimable too, and that is deliberate — a
   * worker that died between marking a row `SENDING` and recording its attempt
   * would otherwise leave it stuck there for ever.
   *
   * What this can cost is stated rather than hidden: a process that sent a
   * message and died before committing the attempt will send that message
   * again when the lease expires. The alternative — marking sent before
   * sending — loses messages instead, and a duplicate expiry reminder is a
   * smaller harm than a missing one (ADR § 7).
   */
  async claimSendable(
    owner: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<SendableDelivery[]> {
    return runUnscoped(
      'the mail worker claims due deliveries across tenants; each is sent in its own tenant context',
      async () => {
        const claimed = await this.prisma.client.$queryRaw<{ id: string }[]>`
          WITH "candidates" AS (
            SELECT "id"
              FROM "notification_delivery"
             WHERE "channel" = 'EMAIL'
               AND "status" IN ('QUEUED', 'SENDING')
               AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= now())
               AND ("claim_expires_at" IS NULL OR "claim_expires_at" <= now())
             ORDER BY "next_attempt_at" ASC NULLS FIRST, "created_at" ASC
             LIMIT ${batchSize}
               FOR UPDATE SKIP LOCKED
          )
          UPDATE "notification_delivery" AS "d"
             SET "claim_token"      = gen_random_uuid()::text,
                 "claim_owner"      = ${owner},
                 "claim_expires_at" = now() + make_interval(secs => ${leaseSeconds}),
                 "status"           = 'SENDING',
                 "updated_at"       = now()
            FROM "candidates"
           WHERE "d"."id" = "candidates"."id"
          RETURNING "d"."id"
        `;
        if (claimed.length === 0) return [];

        // The address and the locale come from the resolution snapshot, joined
        // here rather than looked up from identity: the snapshot is what this
        // notification was resolved against, and asking identity again would
        // answer a different question (ADR § 2).
        return this.prisma.client.$queryRaw<SendableDelivery[]>`
          SELECT "d"."id",
                 "d"."organization_id"  AS "organizationId",
                 "d"."user_id"          AS "userId",
                 "d"."intent_id"        AS "intentId",
                 "d"."template_key"     AS "templateKey",
                 "d"."template_version" AS "templateVersion",
                 "d"."attempt_count"    AS "attemptCount",
                 "d"."max_attempts"     AS "maxAttempts",
                 "d"."claim_token"      AS "claimToken",
                 "r"."email_snapshot"   AS "email",
                 "r"."locale_snapshot"  AS "locale",
                 "r"."timezone_snapshot" AS "timezone",
                 "i"."severity"::text   AS "severity",
                 "i"."rule_key"         AS "ruleKey",
                 "i"."context_data"     AS "contextData",
                 "i"."correlation_id"   AS "correlationId"
            FROM "notification_delivery" AS "d"
            JOIN "notification_intent" AS "i" ON "i"."id" = "d"."intent_id"
            LEFT JOIN "recipient_resolution" AS "r"
              ON "r"."intent_id" = "d"."intent_id" AND "r"."user_id" = "d"."user_id"
           WHERE "d"."id" IN (${Prisma.join(claimed.map((row) => row.id))})
           ORDER BY "d"."next_attempt_at" ASC NULLS FIRST, "d"."created_at" ASC
        `;
      },
    );
  }

  /**
   * Records one attempt and whatever it decided about the delivery.
   *
   * Every write is fenced on the claim token, so a worker whose lease was
   * taken over while it talked to a mail server changes nothing — including
   * the attempt row, which is written inside the same transaction as the
   * status change rather than before it. An attempt recorded by a worker that
   * no longer owns the row would be a second opinion in an append-only table.
   *
   * `publish` runs in the same transaction, so the outcome and the event
   * announcing it commit together (AGENTS.md A-08).
   */
  async settleAttempt(input: {
    delivery: Pick<
      SendableDelivery,
      'id' | 'organizationId' | 'claimToken' | 'attemptCount' | 'maxAttempts'
    >;
    outcome: 'SUCCESS' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE';
    errorClass: string | null;
    startedAt: Date;
    finishedAt: Date;
    /** Set only on success — the SHA-256 of what was sent, never the text. */
    renderedHash?: string;
    /** When to try again. Null on a terminal outcome. */
    nextAttemptAt: Date | null;
    publish?: (tx: ExtendedPrismaClient) => Promise<unknown>;
  }): Promise<'SENT' | 'FAILED' | 'DEAD' | 'RETRY' | 'LEASE_LOST'> {
    const { delivery } = input;
    const attemptNo = delivery.attemptCount + 1;

    return this.prisma.transaction(async (tx) => {
      const settled = await this.resolveTerminal(input, attemptNo);

      const fenced = await tx.notificationDelivery.updateMany({
        where: { id: delivery.id, claimToken: delivery.claimToken, status: 'SENDING' },
        data: {
          status: settled.status,
          attemptCount: attemptNo,
          lastErrorClass: input.errorClass,
          renderedHash: input.renderedHash ?? undefined,
          sentAt: settled.status === 'SENT' ? input.finishedAt : undefined,
          // A retry keeps its due time; a terminal row must not carry one
          // (`ck_delivery_next_attempt_only_when_open`).
          nextAttemptAt: settled.status === 'QUEUED' ? input.nextAttemptAt : null,
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (fenced.count !== 1) throw new LeaseLostError(delivery.id);

      await tx.deliveryAttempt.create({
        data: {
          id: newId('attempt'),
          deliveryId: delivery.id,
          organizationId: delivery.organizationId,
          attemptNo,
          outcome: input.outcome,
          errorClass: input.errorClass,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
        },
      });

      if (input.publish) await input.publish(tx);
      return settled.reported;
    }, DISPATCH_TRANSACTION);
  }

  /**
   * Which terminal state one attempt leaves behind.
   *
   * `DEAD` only once the attempts are genuinely spent, which the database also
   * refuses to accept otherwise (`ck_delivery_dead_exhausted`): the ladder and
   * the constraint have to agree, and the constraint is the one that cannot be
   * forgotten.
   */
  private async resolveTerminal(
    input: { outcome: string; delivery: Pick<SendableDelivery, 'maxAttempts'> },
    attemptNo: number,
  ): Promise<{
    status: 'SENT' | 'FAILED' | 'DEAD' | 'QUEUED';
    reported: 'SENT' | 'FAILED' | 'DEAD' | 'RETRY';
  }> {
    if (input.outcome === 'SUCCESS') return { status: 'SENT', reported: 'SENT' };
    if (input.outcome === 'PERMANENT_FAILURE') return { status: 'FAILED', reported: 'FAILED' };
    if (attemptNo >= input.delivery.maxAttempts) return { status: 'DEAD', reported: 'DEAD' };
    return { status: 'QUEUED', reported: 'RETRY' };
  }

  /** The quiet window a recipient holds, if any. Read again at send time. */
  async quietWindowFor(
    organizationId: string,
    userId: string,
  ): Promise<{ startMinute: number; endMinute: number; timezone: string } | null> {
    const row = await this.prisma.client.notificationQuietHours.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { startMinute: true, endMinute: true, timezone: true },
    });
    return row ?? null;
  }

  /** Hands a claimed delivery back untouched — a deferral is not an attempt. */
  async releaseUntil(
    delivery: Pick<SendableDelivery, 'id' | 'claimToken'>,
    nextAttemptAt: Date,
    scheduledFor: Date | null,
  ): Promise<boolean> {
    const result = await this.prisma.client.notificationDelivery.updateMany({
      where: { id: delivery.id, claimToken: delivery.claimToken, status: 'SENDING' },
      data: {
        status: 'QUEUED',
        nextAttemptAt,
        scheduledFor: scheduledFor ?? undefined,
        claimToken: null,
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
    return result.count === 1;
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
