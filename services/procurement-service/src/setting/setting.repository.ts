import { Injectable } from '@nestjs/common';
import type { AggregationSetting } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ShortfallPolicy } from '../config/env';

/**
 * An organization's aggregation settings (plan PR 3): versions 1, 2, 3… of its own, never changed
 * or erased (`aggregation_setting_guard`). Every read names the organization (AGENTS.md A-04).
 */
@Injectable()
export class AggregationSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The version in force — the largest — or null when the organization has none. */
  current(
    organizationId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<AggregationSetting | null> {
    return client.aggregationSetting.findFirst({
      where: { organizationId },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * Writes `version`, which the guard accepts only as the next one: a writer that raced another to
   * the same number meets the guard's `ck_aggregation_setting_next_version` (the other committed
   * first) or the primary key (it had not yet) — both 409 in the service.
   */
  record(
    tx: ExtendedPrismaClient,
    setting: {
      organizationId: string;
      version: number;
      windowHours: number;
      minQuantity: number;
      shortfallPolicy: ShortfallPolicy;
      recordedBy: string;
      recordedAt: Date;
      correlationId: string;
    },
  ): Promise<AggregationSetting> {
    return tx.aggregationSetting.create({ data: setting });
  }
}
