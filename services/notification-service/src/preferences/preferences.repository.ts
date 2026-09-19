import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationActor } from '../access/access';
import { newId } from '../intake/intake';
import type { PreferenceInput } from './preferences.dto';
import type { PreferenceRow } from './precedence';

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
