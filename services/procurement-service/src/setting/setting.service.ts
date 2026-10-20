import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { AggregationSetting } from '../generated/prisma';
import { ProcurementAccess } from '../access/access';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { DatabaseClock } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ENV } from '../tokens';
import type { ProcurementEnv, ShortfallPolicy } from '../config/env';
import { snapshotOf } from '../demand/demand.repository';
import type { SettingSnapshot } from '../demand/demand.state-machine';
import { AggregationSettingRepository } from './setting.repository';
import type { AggregationSettingView, RecordAggregationSettingDto } from './dto';

/**
 * An organization's aggregation settings (ADR-070 § 2, plan PR 3; docs/24 Q-10, Q-119 (2), (3)).
 *
 * One setting for the whole organization, every product (Q-119 (3)), written by the roles
 * `PROCUREMENT_AGGREGATION_SETTING_ROLES` names in the organization itself — never by the platform
 * operator or the oversight role (Q-119 (2)). Each change is a new version; none is edited. A window
 * takes the version in force when it opens and keeps it (`docs/08` § 8.9): a change reaches only
 * windows opened after it. With no version, the environment defaults of Q-10 are in force — the
 * behaviour of plan PRs 1 and 2, unchanged.
 */
@Injectable()
export class AggregationSettingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AggregationSettingRepository,
    private readonly access: ProcurementAccess,
    private readonly publisher: EventPublisher,
    private readonly clock: DatabaseClock,
    @Inject(ENV) private readonly env: ProcurementEnv,
  ) {}

  /** The settings in force for the caller organization's next windows. */
  async current(): Promise<AggregationSettingView> {
    const acting = this.access.assertSettingReader();
    return this.viewOf(await this.repository.current(acting.organizationId));
  }

  /**
   * A new version, the next after the one the caller saw (`expectedCurrentVersion`), with its
   * `AGGREGATION_SETTING_CHANGED` in the same transaction. Any other current version — another
   * writer got there first — is 409 OPTIMISTIC_LOCK_FAILED and nothing is written; so is the loser
   * of two writers that both read the same version (the primary key, under the guard that numbers
   * versions without a gap).
   */
  async record(
    dto: RecordAggregationSettingDto,
    fence: ClaimFence<AggregationSettingView>,
  ): Promise<AggregationSettingView> {
    const acting = this.access.assertSettingWriter();
    const actor = currentActor({ requirePlatformUserId: true });
    const correlationId = getContext().correlationId;

    try {
      return await this.prisma.transaction(async (tx) => {
        await fence.hold(tx);

        const current = await this.repository.current(acting.organizationId, tx);
        if ((current?.version ?? null) !== dto.expectedCurrentVersion) {
          throw RastaError.optimisticLockFailed('AggregationSetting', acting.organizationId);
        }

        const now = await this.clock.now(tx);
        const version = (current?.version ?? 0) + 1;
        const recorded = await this.repository.record(tx, {
          organizationId: acting.organizationId,
          version,
          windowHours: dto.windowHours,
          minQuantity: dto.minQuantity,
          shortfallPolicy: dto.shortfallPolicy,
          recordedBy: actor.userId,
          recordedAt: now,
          correlationId,
        });
        await this.publisher.enqueue(tx, {
          eventName: 'AGGREGATION_SETTING_CHANGED',
          aggregateId: acting.organizationId,
          organizationId: acting.organizationId,
          occurredAt: now,
          payload: {
            organizationId: acting.organizationId,
            settingVersion: version,
            previousVersion: current?.version ?? null,
            windowHours: dto.windowHours,
            minQuantity: dto.minQuantity,
            shortfallPolicy: dto.shortfallPolicy,
            recordedBy: actor.userId,
            recordedAt: now.toISOString(),
          },
        });
        return fence.complete(tx, this.viewOf(recorded));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw RastaError.optimisticLockFailed('AggregationSetting', acting.organizationId);
      }
      throw error;
    }
  }

  /** The rule a fresh recording applies, checked before a stored answer is replayed. */
  assertMayRecord(): void {
    this.access.assertSettingWriter();
  }

  /**
   * What a window opening now in `organizationId` takes: the version in force, read in the
   * opening transaction, or the environment defaults (Q-10) when the organization has none.
   */
  async snapshotFor(tx: ExtendedPrismaClient, organizationId: string): Promise<SettingSnapshot> {
    const current = await this.repository.current(organizationId, tx);
    return current ? settingOf(current) : { ...snapshotOf(this.env), settingVersion: null };
  }

  private viewOf(setting: AggregationSetting | null): AggregationSettingView {
    const snapshot = setting
      ? settingOf(setting)
      : { ...snapshotOf(this.env), settingVersion: null };
    return { ...snapshot, recordedAt: setting ? setting.recordedAt.toISOString() : null };
  }
}

function settingOf(setting: AggregationSetting): SettingSnapshot {
  return {
    windowHours: setting.windowHours,
    minQuantity: setting.minQuantity,
    shortfallPolicy: setting.shortfallPolicy as ShortfallPolicy,
    settingVersion: setting.version,
  };
}
