import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { NotificationApiService } from './notification.service';
import {
  listNotificationsQuerySchema,
  notificationIdSchema,
  readAllQuerySchema,
  type ListNotificationsQuery,
} from './notification.dto';
import type {
  NotificationPage,
  NotificationView,
  ReadAllResult,
  UnreadCount,
} from './notification.view';

/**
 * The in-app inbox — six endpoints, every one "the caller's own rows only"
 * (ADR-054 § 11).
 *
 * ## Closed by default, and no exceptions here
 *
 * `AuthGuard` and `RolesGuard` are global. Nothing in this class carries
 * `@Public` or `@AllowService`, and nothing carries `@Roles` either: every
 * authenticated person has an inbox, including `AUDITOR`, and no role sees
 * anybody else's. A service token is refused by the guard and again by
 * `resolveActor()`.
 *
 * ## Route order is load-bearing
 *
 * `unread-count` and `read-all` are declared **before** `:id`. Nest matches
 * in declaration order, so a static path declared after a parameter of the
 * same depth is unreachable — every call would be a lookup for a row whose id
 * is the word "unread-count", answered `404` while looking like the endpoint
 * simply did not work.
 *
 * ## No `DELETE`
 *
 * Dismiss is the user-side removal; the row stays until retention
 * (ADR-054 § 11). A `DELETE` here gets the router's `404`, which
 * `test/api.int-spec.ts` asserts.
 *
 * ## No business logic here
 *
 * A pipe validates, the service resolves the actor and reads or transitions,
 * a view serialises (AGENTS.md A-10). Every handler is one line.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications', version: '1' })
export class NotificationController {
  constructor(private readonly notifications: NotificationApiService) {}

  @Get()
  @ApiOperation({
    summary: 'List the caller’s own in-app notifications',
    description:
      'Only rows belonging to the authenticated user in the active organization, ' +
      'newest first, paged by an opaque cursor that carries a position and no scope. ' +
      'Omitting `state` returns the inbox (everything not dismissed); `UNREAD`, `READ` ' +
      'and `DISMISSED` narrow it. Expired rows are never returned. `limit` defaults to ' +
      '25 and may not exceed 200.',
  })
  list(
    @Query(zodPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(query);
  }

  // Declared before `:id` — see the note on route order above.
  @Get('unread-count')
  @ApiOperation({
    summary: 'How many unread notifications the caller has, capped at 99',
    description:
      'Counts unread, undismissed, unexpired rows and stops at 99: `{ count: 99, capped: true }` ' +
      'means "at least 99". A badge does not need the exact number, and an unbounded ' +
      'count on a hot path is a load problem waiting to happen (ADR-054 § 4).',
  })
  unreadCount(): Promise<UnreadCount> {
    return this.notifications.unreadCount();
  }

  // Declared before `:id` — see the note on route order above.
  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark every unread notification of the caller as read',
    description:
      'Scoped to the authenticated user in the active organization; rows in the caller’s ' +
      'other organizations and every other person’s rows are untouched. Answers how ' +
      'many rows changed, which is 0 on a repeat call.',
  })
  readAll(
    @Query(zodPipe(readAllQuerySchema)) _query: Record<string, never>,
  ): Promise<ReadAllResult> {
    return this.notifications.markAllRead();
  }

  @Get(':id')
  @ApiParam({ name: 'id', description: 'The notification’s identifier, a prefixed ULID.' })
  @ApiOperation({
    summary: 'One of the caller’s own notifications',
    description:
      'A row that belongs to somebody else — in this organization or any other — answers ' +
      '`404` exactly as an id that does not exist, so a row’s existence is never disclosed ' +
      'by the difference between two statuses (docs/06 § 6.7).',
  })
  get(@Param('id', zodPipe(notificationIdSchema)) id: string): Promise<NotificationView> {
    return this.notifications.get(id);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiParam({ name: 'id', description: 'The notification’s identifier, a prefixed ULID.' })
  @ApiOperation({
    summary: 'Mark one notification as read',
    description:
      'Idempotent and monotonic: a second call answers `200` with the original `readAt` ' +
      'and changes nothing. There is no un-read transition (ADR-054 § 4).',
  })
  markRead(@Param('id', zodPipe(notificationIdSchema)) id: string): Promise<NotificationView> {
    return this.notifications.markRead(id);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @ApiParam({ name: 'id', description: 'The notification’s identifier, a prefixed ULID.' })
  @ApiOperation({
    summary: 'Dismiss one notification',
    description:
      'Sets `dismissedAt`, and `readAt` too if it was unset — dismiss means read. The row ' +
      'is not deleted; it leaves the inbox and stays readable under `state=DISMISSED` ' +
      'until retention (ADR-054 § 4). Idempotent: a second call answers `200` with the ' +
      'original timestamps.',
  })
  dismiss(@Param('id', zodPipe(notificationIdSchema)) id: string): Promise<NotificationView> {
    return this.notifications.dismiss(id);
  }
}
