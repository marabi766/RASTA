import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { assertValidScoreSnapshot, type ScoreSnapshotInput } from './score-snapshot';

/**
 * The score-snapshot store (ADR-052 step 4).
 *
 * `insert` and two reads, and nothing else: a snapshot is never updated or
 * deleted, and the database refuses both. A recomputation — after a late
 * event, a correction or a new formula version — is a new row; the earlier
 * one stays exactly as it was (ADR-052 § 12, § 13, § 15).
 *
 * Tenant-scoped by the supplier organization through the guard, on every
 * write and every read. The snapshot and all of its provenance rows are
 * written in one transaction, which the database also requires.
 */

export interface ScoreSnapshotRow {
  id: string;
  organizationId: string;
  formulaVersionId: string;
  formulaVersion: number;
  windowStart: Date;
  windowEnd: Date;
  calculatedAt: Date;
  status: ScoreSnapshotInput['status'];
  scoreCentis: number | null;
  eligibleSampleCount: number;
  coverageBp: number;
  correlationId: string;
  components: {
    component: ScoreSnapshotInput['components'][number]['component'];
    configuredWeightBp: number;
    effectiveWeightBp: number | null;
    componentScoreCentis: number | null;
    sampleCount: number;
  }[];
  sourceEvents: { sourceEventId: string }[];
}

const WITH_PROVENANCE = {
  components: {
    select: {
      component: true,
      configuredWeightBp: true,
      effectiveWeightBp: true,
      componentScoreCentis: true,
      sampleCount: true,
    },
    orderBy: { component: 'asc' },
  },
  sourceEvents: { select: { sourceEventId: true }, orderBy: { sourceEventId: 'asc' } },
} as const;

@Injectable()
export class ScoreSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes a snapshot and its provenance in the caller's transaction. Returns its id. */
  async insert(tx: ExtendedPrismaClient, input: ScoreSnapshotInput): Promise<string> {
    assertValidScoreSnapshot(input);
    const id = `PSS_${ulid()}`;

    await tx.performanceScoreSnapshot.create({
      data: {
        id,
        organizationId: input.organizationId,
        formulaVersionId: input.formulaVersionId,
        formulaVersion: input.formulaVersion,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        status: input.status,
        scoreCentis: input.scoreCentis,
        eligibleSampleCount: input.eligibleSampleCount,
        coverageBp: input.coverageBp,
        correlationId: input.correlationId,
      },
    });
    await tx.performanceScoreComponent.createMany({
      data: input.components.map((row) => ({
        organizationId: input.organizationId,
        snapshotId: id,
        component: row.component,
        configuredWeightBp: row.configuredWeightBp,
        effectiveWeightBp: row.effectiveWeightBp,
        componentScoreCentis: row.componentScoreCentis,
        sampleCount: row.sampleCount,
      })),
    });
    if (input.sourceEventIds.length > 0) {
      await tx.performanceScoreSourceEvent.createMany({
        data: input.sourceEventIds.map((sourceEventId) => ({
          organizationId: input.organizationId,
          snapshotId: id,
          sourceEventId,
        })),
      });
    }
    return id;
  }

  /** One snapshot of the caller's tenant, with its provenance, or `null`. */
  async findById(id: string): Promise<ScoreSnapshotRow | null> {
    return this.prisma.client.performanceScoreSnapshot.findFirst({
      where: { id },
      include: WITH_PROVENANCE,
    });
  }

  /**
   * The caller's tenant's most recent snapshot, or `null`.
   *
   * `(calculatedAt, id)` descending — a total order, because two snapshots in
   * one millisecond would otherwise tie.
   */
  async findLatest(): Promise<ScoreSnapshotRow | null> {
    return this.prisma.client.performanceScoreSnapshot.findFirst({
      orderBy: [{ calculatedAt: 'desc' }, { id: 'desc' }],
      include: WITH_PROVENANCE,
    });
  }
}
