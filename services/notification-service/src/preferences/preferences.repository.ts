import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationActor } from '../access/access';
import { EventPublisher } from '../events/publisher';
import { NOTIFICATION_EVENTS } from '../events/published';
import { newId } from '../intake/intake';
import type { PreferenceInput } from './preferences.dto';
import type { PreferenceRow } from './precedence';

/** The stored shape of a quiet window: minutes from local midnight, and a zone. */
export interface QuietHoursRow {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timezone: string;
}

/**
 * The caller's own preference rows, for one tenant.
 *
 * Every query names `userId` and `organizationId` explicitly, even though the
 * tenant guard would inject the organization anyway — the same reason the in-app
 * repository does it: a reader of one method sees the whole ownership rule
 * without having to know the guard exists, and the guard proves only the tenant
 * half. The *user* half (S-03, two people in one organization must not read each
 * other's settings) is this file's job.
 *
 * ## Every change is audited
 *
 * Both writes publish their audit event in the same transaction as the rows
 * (AGENTS.md S-06, A-08; global audit L7-14), and only when the stored state
 * actually changed — the rule `markAllRead` set: an audit record for an action
 * with no effect is noise that makes the real records harder to find. The
 * writes themselves are unchanged; only what they announce is new.
 */
@Injectable()
export class PreferencesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisher,
  ) {}

  async listOwn(actor: NotificationActor): Promise<PreferenceRow[]> {
    const rows = await this.prisma.client.notificationPreference.findMany({
      where: { userId: actor.userId, organizationId: actor.organizationId },
      orderBy: [{ scope: 'asc' }, { scopeKey: 'asc' }, { channel: 'asc' }],
      select: { scope: true, scopeKey: true, channel: true, enabled: true },
    });
    return rows;
  }

  /**
   * The caller's own quiet window, or null.
   *
   * Keyed by `(user, organization)` rather than living on a preference row —
   * see the NTF-004 migration header for why that shape could not answer which
   * of three rows a delivery obeys.
   */
  async quietHours(actor: NotificationActor): Promise<QuietHoursRow | null> {
    const row = await this.prisma.client.notificationQuietHours.findUnique({
      where: {
        organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
      },
      select: { startMinute: true, endMinute: true, timezone: true },
    });
    return row ?? null;
  }

  /** Sets or clears it. `null` is "no quiet window", which is the default state. */
  async replaceQuietHours(
    actor: NotificationActor,
    window: QuietHoursRow | null,
    now: Date = new Date(),
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const where = {
        organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
      };
      const before = await tx.notificationQuietHours.findUnique({
        where,
        select: { startMinute: true, endMinute: true, timezone: true },
      });

      if (!window) {
        await tx.notificationQuietHours.deleteMany({
          where: { userId: actor.userId, organizationId: actor.organizationId },
        });
      } else {
        await tx.notificationQuietHours.upsert({
          where,
          create: {
            userId: actor.userId,
            organizationId: actor.organizationId,
            ...window,
            updatedBy: actor.userId,
          },
          update: { ...window, updatedBy: actor.userId },
        });
      }

      if (sameWindow(before, window)) return;

      await this.events.enqueue(tx, {
        eventName: NOTIFICATION_EVENTS.NOTIFICATION_QUIET_HOURS_CHANGED,
        aggregateId: `${actor.organizationId}:${actor.userId}`,
        organizationId: actor.organizationId,
        payload: {
          quietHours: window
            ? {
                startMinute: window.startMinute,
                endMinute: window.endMinute,
                timezone: window.timezone,
              }
            : null,
          organizationId: actor.organizationId,
          userId: actor.userId,
          occurredAt: now.toISOString(),
        },
      });
    });
  }

  /**
   * Replaces the caller's whole preference set for this tenant, atomically.
   *
   * Delete-then-insert rather than an upsert loop, because `PUT` means "this is
   * what I have now" and a row the caller left out has to disappear. Inside one
   * transaction, so a crash between the two halves cannot leave somebody with no
   * preferences at all — which would silently restore every default they had
   * turned off.
   */
  async replaceOwn(
    actor: NotificationActor,
    preferences: readonly PreferenceInput[],
    now: Date = new Date(),
  ): Promise<void> {
    const next = normalise(
      preferences.map((preference) => ({
        scope: preference.scope,
        scopeKey: preference.scope === 'GLOBAL' ? null : (preference.scopeKey ?? null),
        channel: preference.channel,
        enabled: preference.enabled,
      })),
    );

    await this.prisma.transaction(async (tx) => {
      const before = normalise(
        await tx.notificationPreference.findMany({
          where: { userId: actor.userId, organizationId: actor.organizationId },
          select: { scope: true, scopeKey: true, channel: true, enabled: true },
        }),
      );

      await tx.notificationPreference.deleteMany({
        where: { userId: actor.userId, organizationId: actor.organizationId },
      });

      if (preferences.length > 0) {
        await tx.notificationPreference.createMany({
          data: preferences.map((preference) => ({
            id: newId('preference'),
            organizationId: actor.organizationId,
            userId: actor.userId,
            scope: preference.scope,
            scopeKey: preference.scope === 'GLOBAL' ? null : (preference.scopeKey ?? null),
            channel: preference.channel,
            enabled: preference.enabled,
            updatedBy: actor.userId,
          })),
        });
      }

      if (JSON.stringify(before) === JSON.stringify(next)) return;

      await this.events.enqueue(tx, {
        eventName: NOTIFICATION_EVENTS.NOTIFICATION_PREFERENCES_REPLACED,
        aggregateId: `${actor.organizationId}:${actor.userId}`,
        organizationId: actor.organizationId,
        payload: {
          preferences: next,
          organizationId: actor.organizationId,
          userId: actor.userId,
          occurredAt: now.toISOString(),
        },
      });
    });
  }
}

interface StoredPreference {
  readonly scope: string;
  readonly scopeKey: string | null;
  readonly channel: string;
  readonly enabled: boolean;
}

/**
 * A preference set in one fixed order, with exactly the four stored fields.
 *
 * So that "did this change anything" is a comparison of two canonical lists,
 * and the event carries the set in an order that does not depend on the order
 * a client happened to send it in.
 */
function normalise(rows: readonly StoredPreference[]): StoredPreference[] {
  const key = (row: StoredPreference) =>
    `${row.scope}\u0000${row.scopeKey ?? ''}\u0000${row.channel}`;
  return rows
    .map((row) => ({
      scope: row.scope,
      scopeKey: row.scopeKey,
      channel: row.channel,
      enabled: row.enabled,
    }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function sameWindow(a: QuietHoursRow | null, b: QuietHoursRow | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.startMinute === b.startMinute && a.endMinute === b.endMinute && a.timezone === b.timezone
  );
}
