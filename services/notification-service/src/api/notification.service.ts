import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { resolveActor, type NotificationActor } from '../access/access';
import { InAppRepository } from './in-app.repository';
import { decodeCursor, encodeCursor, InvalidCursorError } from './notification.cursor';
import { UNREAD_COUNT_CAP, type ListNotificationsQuery } from './notification.dto';
import {
  toNotificationView,
  type NotificationPage,
  type NotificationView,
  type ReadAllResult,
  type UnreadCount,
} from './notification.view';
import { notificationInAppTransitionsTotal, IN_APP_TRANSITIONS } from '../observability/metrics';
import { SCRUBBED_LOGGER } from '../tokens';
import type { ScrubbedLogger } from '../logging/scrub';

/**
 * The read side of the in-app channel (ADR-054 § 4, § 11).
 *
 * Every method starts by resolving the actor from the verified token and
 * ends by serialising rows through one view. In between there is no
 * decision about *who* may see *what* beyond the ownership predicate the
 * repository carries: this API has no administrative mode, no "on behalf
 * of", and no way to name a tenant.
 *
 * ## `404`, never `403`, for a row that is not the caller's
 *
 * `docs/06` § 6.7 and ADR-054 § 11: a foreign row — another person's, in this
 * organization or any other — answers exactly as an id that does not exist.
 * Two statuses would tell a caller which ids are real.
 *
 * ## Transitions are recorded, and recorded once
 *
 * `read` and `dismiss` are idempotent and monotonic: the second call answers
 * `200` with the original timestamps, and the database refuses a rewind
 * (`in_app_notification_state_write_once`). Each *actual* transition is
 * logged with the actor, tenant and correlation id the request context
 * already carries, and counted by transition kind — bounded labels only.
 */
@Injectable()
export class NotificationApiService {
  constructor(
    private readonly repository: InAppRepository,
    @Inject(SCRUBBED_LOGGER) private readonly logger: ScrubbedLogger,
  ) {}

  async list(query: ListNotificationsQuery): Promise<NotificationPage> {
    const actor = resolveActor();
    const cursor = query.cursor === undefined ? undefined : this.parseCursor(query.cursor);

    const { rows, hasMore } = await this.repository.listPage({
      actor,
      limit: query.limit,
      state: query.state,
      cursor,
      now: new Date(),
    });

    const last = rows[rows.length - 1];
    return {
      items: rows.map(toNotificationView),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      hasMore,
    };
  }

  async unreadCount(): Promise<UnreadCount> {
    const actor = resolveActor();
    const count = await this.repository.unreadCount(actor, UNREAD_COUNT_CAP, new Date());
    return { count, capped: count >= UNREAD_COUNT_CAP };
  }

  async get(id: string): Promise<NotificationView> {
    const actor = resolveActor();
    const row = await this.repository.findOwned(actor, id, new Date());
    if (!row) throw this.notFound(id);
    return toNotificationView(row);
  }

  async markRead(id: string): Promise<NotificationView> {
    const actor = resolveActor();
    const before = await this.repository.findOwned(actor, id, new Date());
    if (!before) throw this.notFound(id);

    if (before.readAt !== null) {
      // Already read: the same answer as the first call, and no second effect.
      return toNotificationView(before);
    }

    const row = await this.repository.markRead(actor, id, new Date());
    if (!row) throw this.notFound(id);
    this.recordTransition(actor, IN_APP_TRANSITIONS.READ, row.id);
    return toNotificationView(row);
  }

  async dismiss(id: string): Promise<NotificationView> {
    const actor = resolveActor();
    const before = await this.repository.findOwned(actor, id, new Date());
    if (!before) throw this.notFound(id);

    if (before.dismissedAt !== null) {
      return toNotificationView(before);
    }

    const row = await this.repository.dismiss(actor, id, new Date());
    if (!row) throw this.notFound(id);
    this.recordTransition(actor, IN_APP_TRANSITIONS.DISMISSED, row.id);
    return toNotificationView(row);
  }

  async markAllRead(): Promise<ReadAllResult> {
    const actor = resolveActor();
    const updated = await this.repository.markAllRead(actor, new Date());
    if (updated > 0) {
      notificationInAppTransitionsTotal.inc({ transition: IN_APP_TRANSITIONS.READ_ALL }, updated);
      this.logger.info(
        `${updated} in-app notifications marked read for ${actor.userId} in ${actor.organizationId}`,
      );
    }
    return { updated };
  }

  private parseCursor(raw: string) {
    try {
      return decodeCursor(raw);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw RastaError.validation(
          [{ path: 'cursor', message: 'The cursor is not valid' }],
          'Request validation failed',
        );
      }
      throw error;
    }
  }

  private notFound(id: string): RastaError {
    return RastaError.notFound('Notification', id);
  }

  /**
   * The who/what/when/where of a state change (AGENTS.md S-06), written to
   * the structured log under the request's correlation id, tenant and user.
   * A domain event for this transition is not published: this service has no
   * outbox until NTF-004, and no such event exists in the catalogue.
   */
  private recordTransition(actor: NotificationActor, transition: string, id: string): void {
    notificationInAppTransitionsTotal.inc({ transition });
    this.logger.info(
      `In-app notification ${id} ${transition} by ${actor.userId} in ${actor.organizationId}`,
    );
  }
}
