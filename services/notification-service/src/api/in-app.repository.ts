import { Injectable } from '@nestjs/common';
import type { InAppNotification, Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { NotificationActor } from '../access/access';
import { EventPublisher } from '../events/publisher';
import { NOTIFICATION_EVENTS } from '../events/published';
import type { InAppState } from './notification.dto';
import type { NotificationCursor } from './notification.cursor';

/**
 * Reads and transitions on a person's own in-app rows.
 *
 * ## The one predicate every query carries
 *
 * `userId = actor.userId AND organizationId = actor.organizationId`, written
 * explicitly in every `where` even though the tenant guard would inject the
 * organization anyway. Two reasons: a reader of any single method can see the
 * whole ownership rule without knowing the guard exists, and the guard proves
 * the *tenant* half only — the *user* half (S-03, "two users in one
 * organization must not see each other's rows") is this file's job and
 * nobody else's.
 *
 * ## Transitions are conditional updates, not read-then-write
 *
 * "Mark read" is `UPDATE … WHERE … AND read_at IS NULL`. If the row was
 * already read the statement matches nothing, the original timestamp stays,
 * and the caller gets the row as it is — which is what makes the endpoint
 * idempotent under concurrency without a lock. The database trigger from
 * NTF-002's migration makes a rewind impossible even for a future caller that
 * forgets the predicate.
 *
 * ## Expired rows are invisible
 *
 * `expires_at > now` on every read and every transition. A row past its
 * retention is hidden by default (ADR-054 § 4) and removed by the sweep
 * (NTF-005); it is never listed, and acting on it is a 404 like any other row
 * the caller cannot see.
 *
 * ## Every transition announces itself, in the same transaction
 *
 * `AGENTS.md` S-06 requires an audit record for every state-changing action,
 * and `audit-service` has one input: the event log. `ADR-054 § 3` recorded the
 * absence of these events as a deviation from a binding rule and refused to
 * accept `NTF-002` until it closed. The event is written here rather than in
 * the service layer for a reason that is not stylistic: **only this file knows
 * whether anything actually moved**.
 *
 * The conditional update is what makes these endpoints idempotent, and it is
 * also what makes "did this call change the world" a number rather than a
 * guess. Two concurrent requests can both see an unread row, both call
 * `markRead`, and exactly one `UPDATE` will match. Publishing from the service
 * layer — which sees only the row afterwards — would announce the same read
 * twice. Publishing on `count > 0`, inside the transaction that produced the
 * count, announces it once or not at all.
 */

const IN_APP_ORDER: Prisma.InAppNotificationOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

export interface ListPageInput {
  readonly actor: NotificationActor;
  readonly limit: number;
  readonly state?: InAppState;
  readonly cursor?: NotificationCursor;
  readonly now: Date;
}

@Injectable()
export class InAppRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisher,
  ) {}

  private owned(actor: NotificationActor, now: Date): Prisma.InAppNotificationWhereInput {
    return {
      userId: actor.userId,
      organizationId: actor.organizationId,
      expiresAt: { gt: now },
    };
  }

  private stateFilter(state: InAppState | undefined): Prisma.InAppNotificationWhereInput {
    switch (state) {
      case 'UNREAD':
        return { readAt: null, dismissedAt: null };
      case 'READ':
        return { readAt: { not: null }, dismissedAt: null };
      case 'DISMISSED':
        return { dismissedAt: { not: null } };
      default:
        return { dismissedAt: null };
    }
  }

  /** One page, newest first, plus one extra row to learn whether another page exists. */
  async listPage(input: ListPageInput): Promise<{ rows: InAppNotification[]; hasMore: boolean }> {
    const where: Prisma.InAppNotificationWhereInput = {
      ...this.owned(input.actor, input.now),
      ...this.stateFilter(input.state),
    };

    if (input.cursor) {
      // Strictly after the cursor position in `(createdAt DESC, id DESC)`
      // order. Written as an OR of two ranges rather than a row-value
      // comparison because Prisma's filter language has no tuple operator.
      where.AND = [
        {
          OR: [
            { createdAt: { lt: input.cursor.createdAt } },
            { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
          ],
        },
      ];
    }

    const rows = await this.prisma.client.inAppNotification.findMany({
      where,
      orderBy: IN_APP_ORDER,
      take: input.limit + 1,
    });

    return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }

  /**
   * The unread count, bounded by `cap`.
   *
   * `take: cap` on a select of ids rather than `count(*)`, so the query stops
   * at the cap instead of scanning every unread row a busy account holds
   * (ADR-054 § 4). The partial index `ix_in_app_unread` is exactly this scan.
   */
  async unreadCount(actor: NotificationActor, cap: number, now: Date): Promise<number> {
    const rows = await this.prisma.client.inAppNotification.findMany({
      where: { ...this.owned(actor, now), readAt: null, dismissedAt: null },
      select: { id: true },
      take: cap,
    });
    return rows.length;
  }

  async findOwned(
    actor: NotificationActor,
    id: string,
    now: Date,
  ): Promise<InAppNotification | null> {
    return this.prisma.client.inAppNotification.findFirst({
      where: { ...this.owned(actor, now), id },
    });
  }

  /**
   * Sets `readAt` if unset, and announces the read when it moved a row.
   *
   * Returns the row afterwards, or null when the caller owns no such row — the
   * two outcomes a 404 must not distinguish.
   */
  async markRead(
    actor: NotificationActor,
    id: string,
    now: Date,
  ): Promise<InAppNotification | null> {
    return this.prisma.transaction(async (tx) => {
      const moved = await tx.inAppNotification.updateMany({
        where: { ...this.owned(actor, now), id, readAt: null },
        data: { readAt: now },
      });

      if (moved.count > 0) {
        await this.events.enqueue(tx, {
          eventName: NOTIFICATION_EVENTS.NOTIFICATION_READ,
          aggregateId: id,
          organizationId: actor.organizationId,
          payload: {
            notificationId: id,
            organizationId: actor.organizationId,
            userId: actor.userId,
            occurredAt: now.toISOString(),
          },
        });
      }

      return this.findOwnedIn(tx, actor, id, now);
    });
  }

  /**
   * Sets `dismissedAt` if unset, and `readAt` too if that was unset: dismiss
   * means read (ADR-054 § 4), and `ck_in_app_dismiss_implies_read` refuses the
   * alternative. Two statements rather than one so a row that was already
   * read keeps its original `readAt` — the trigger would refuse moving it.
   *
   * One event, not two. A dismissal that also marked the row read is a single
   * action a person took, and `markedReadByDismissal` says which of the two
   * shapes it had. Emitting a separate `NOTIFICATION_READ` alongside it would
   * make one click look like two decisions in the audit trail.
   */
  async dismiss(
    actor: NotificationActor,
    id: string,
    now: Date,
  ): Promise<InAppNotification | null> {
    return this.prisma.transaction(async (tx) => {
      const readAndDismissed = await tx.inAppNotification.updateMany({
        where: { ...this.owned(actor, now), id, readAt: null, dismissedAt: null },
        data: { readAt: now, dismissedAt: now },
      });
      const dismissedOnly = await tx.inAppNotification.updateMany({
        where: { ...this.owned(actor, now), id, dismissedAt: null },
        data: { dismissedAt: now },
      });

      const moved = readAndDismissed.count + dismissedOnly.count;
      if (moved > 0) {
        await this.events.enqueue(tx, {
          eventName: NOTIFICATION_EVENTS.NOTIFICATION_DISMISSED,
          aggregateId: id,
          organizationId: actor.organizationId,
          payload: {
            notificationId: id,
            markedReadByDismissal: readAndDismissed.count > 0,
            organizationId: actor.organizationId,
            userId: actor.userId,
            occurredAt: now.toISOString(),
          },
        });
      }

      return this.findOwnedIn(tx, actor, id, now);
    });
  }

  /**
   * Every unread, undismissed row of this actor becomes read. Returns how many.
   *
   * One event carrying the count, not one per row. A person with two hundred
   * unread notifications would otherwise produce two hundred events for a
   * single click, which tells an auditor less than one event saying exactly
   * that. A call that moved nothing announces nothing: an audit record for an
   * action with no effect is noise that makes the real records harder to find.
   */
  async markAllRead(actor: NotificationActor, now: Date): Promise<number> {
    return this.prisma.transaction(async (tx) => {
      const result = await tx.inAppNotification.updateMany({
        where: { ...this.owned(actor, now), readAt: null, dismissedAt: null },
        data: { readAt: now },
      });

      if (result.count > 0) {
        await this.events.enqueue(tx, {
          eventName: NOTIFICATION_EVENTS.NOTIFICATION_ALL_READ,
          // The inbox, not any one row: naming an arbitrary notification would
          // attach the whole action to whichever row happened to be first.
          aggregateId: `${actor.organizationId}:${actor.userId}`,
          organizationId: actor.organizationId,
          payload: {
            count: result.count,
            organizationId: actor.organizationId,
            userId: actor.userId,
            occurredAt: now.toISOString(),
          },
        });
      }

      return result.count;
    });
  }

  /** `findOwned`, bound to a transaction so a caller reads its own writes. */
  private findOwnedIn(
    tx: ExtendedPrismaClient,
    actor: NotificationActor,
    id: string,
    now: Date,
  ): Promise<InAppNotification | null> {
    return tx.inAppNotification.findFirst({ where: { ...this.owned(actor, now), id } });
  }
}
