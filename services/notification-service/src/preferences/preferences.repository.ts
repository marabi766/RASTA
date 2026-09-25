import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationActor } from '../access/access';
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
 */
@Injectable()
export class PreferencesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listOwn(actor: NotificationActor): Promise<PreferenceRow[]> {
    const rows = await this.prisma.client.notificationPreference.findMany({
      where: { userId: actor.userId, organizationId: actor.organizationId },
      orderBy: [{ scope: 'asc' }, { scopeKey: 'asc' }, { channel: 'asc' }],
      select: { scope: true, scopeKey: true, channel: true, enabled: true },
    });
    return rows;
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
  async replaceQuietHours(actor: NotificationActor, window: QuietHoursRow | null): Promise<void> {
    if (!window) {
      await this.prisma.client.notificationQuietHours.deleteMany({
        where: { userId: actor.userId, organizationId: actor.organizationId },
      });
      return;
    }

    await this.prisma.client.notificationQuietHours.upsert({
      where: {
        organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId },
      },
      create: {
        userId: actor.userId,
        organizationId: actor.organizationId,
        ...window,
        updatedBy: actor.userId,
      },
      update: { ...window, updatedBy: actor.userId },
    });
  }

  async replaceOwn(
    actor: NotificationActor,
    preferences: readonly PreferenceInput[],
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await tx.notificationPreference.deleteMany({
        where: { userId: actor.userId, organizationId: actor.organizationId },
      });

      if (preferences.length === 0) return;

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
    });
  }
}
