import { ulid } from 'ulid';
import type { PrismaService, ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { transactionNow } from '../src/shared/clock';
import type { ScoreSnapshotInput } from '../src/performance/score-snapshot';
import { ScoreSnapshotRepository } from '../src/performance/score-snapshot.repository';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import { asSupplier, newOrganizationId, newPrisma } from './helpers';
import { ADR_052_V1, asSystemAdmin, wireFormula } from './performance-helpers';

/** Real PostgreSQL: ADR-052 § 8 and the existing D-5 transaction clock. No engine. */
describe('snapshot database transaction clock', () => {
  const DATABASE_DELAY_SECONDS = 0.025;
  let prisma: PrismaService;
  let snapshots: ScoreSnapshotRepository;
  let formula: { id: string; formulaVersion: number };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.assertRuntimeRole();
    snapshots = new ScoreSnapshotRepository(prisma);
    const wiring = wireFormula(prisma);
    formula = await asSystemAdmin(() => wiring.service.createDraft(ADR_052_V1));
    await asSystemAdmin(() => wiring.service.activate(formula.id));
  });

  afterAll(async () => {
    await prisma.stop();
  });

  function empty(organizationId = newOrganizationId()): ScoreSnapshotInput {
    return {
      organizationId,
      formulaVersionId: formula.id,
      formulaVersion: formula.formulaVersion,
      windowStart: new Date('2026-03-30T00:00:00.000Z'),
      windowEnd: new Date('2026-09-26T00:00:00.000Z'),
      status: 'INSUFFICIENT_DATA',
      scoreCentis: null,
      eligibleSampleCount: 0,
      coverageBp: 0,
      correlationId: `clock-${ulid()}`,
      components: ADR_052_V1.weights.map(({ component, weightBp }) => ({
        component,
        configuredWeightBp: weightBp,
        effectiveWeightBp: null,
        componentScoreCentis: null,
        sampleCount: 0,
      })),
      sourceEventIds: [],
    };
  }

  async function delay(tx: ExtendedPrismaClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_sleep(${DATABASE_DELAY_SECONDS}::double precision)`;
  }

  async function storedTime(tx: ExtendedPrismaClient, id: string): Promise<Date> {
    return (await tx.performanceScoreSnapshot.findFirstOrThrow({ where: { id } })).calculatedAt;
  }

  // Legal timestamp-omitting SQL control; all children still belong to the same transaction.
  async function databaseDefault(
    tx: ExtendedPrismaClient,
    input: ScoreSnapshotInput,
  ): Promise<string> {
    const id = `PSS_${ulid()}`;
    await tx.$executeRaw`
      INSERT INTO performance_score_snapshot
        (id, organization_id, formula_version_id, formula_version, window_start, window_end,
         status, score_centis, eligible_sample_count, coverage_bp, correlation_id)
      VALUES (${id}, ${input.organizationId}, ${input.formulaVersionId}, ${input.formulaVersion},
        ${input.windowStart}, ${input.windowEnd}, 'INSUFFICIENT_DATA', NULL, 0, 0,
        ${input.correlationId})`;
    await tx.performanceScoreComponent.createMany({
      data: input.components.map((component) => ({
        ...component,
        organizationId: input.organizationId,
        snapshotId: id,
      })),
    });
    return id;
  }

  it('persists the canonical DB-derived Date after delay; raw DEFAULT uses the same DB authority', async () => {
    const input = empty();
    const proof = await asSupplier(input.organizationId, () =>
      prisma.transaction(async (tx) => {
        const before = await transactionNow(tx);
        const [precision] = await tx.$queryRaw<{ rounded: Date; truncated: Date }[]>`
          SELECT CURRENT_TIMESTAMP::timestamp(3) AS rounded,
                 date_trunc('milliseconds', CURRENT_TIMESTAMP)::timestamp(3) AS truncated`;
        await delay(tx);
        const rawId = await databaseDefault(tx, input);
        const id = await snapshots.insert(tx, input);
        const actual = await storedTime(tx, id);
        const rawTime = await storedTime(tx, rawId);
        const after = await transactionNow(tx);
        return { before, after, precision, rawTime, actual };
      }),
    );
    expect(proof.after).toEqual(proof.before);
    expect(proof.before).toEqual(proof.precision.truncated);
    // PostgreSQL timestamp(3) rounds, whereas the helper's JS Date truncates microseconds.
    expect(proof.rawTime).toEqual(proof.precision.rounded);
    expect(proof.rawTime.getTime() - proof.before.getTime()).toBeGreaterThanOrEqual(0);
    expect(proof.rawTime.getTime() - proof.before.getTime()).toBeLessThanOrEqual(1);
    // Exact canonical helper precision, with no tolerance hiding another clock source.
    expect(proof.actual).toEqual(proof.before);
  });

  it('keeps two delayed inserts on the caller transaction clock', async () => {
    const input = empty();
    const proof = await asSupplier(input.organizationId, () =>
      prisma.transaction(async (tx) => {
        const before = await transactionNow(tx);
        await delay(tx);
        const first = await snapshots.insert(tx, input);
        await delay(tx);
        const second = await snapshots.insert(tx, input);
        return {
          before,
          after: await transactionNow(tx),
          first: await storedTime(tx, first),
          second: await storedTime(tx, second),
        };
      }),
    );
    expect(proof.after).toEqual(proof.before);
    expect(proof.first).toEqual(proof.before);
    expect(proof.second).toEqual(proof.before);
  });

  async function withFact(): Promise<ScoreSnapshotInput> {
    const input = empty();
    const sourceEventId = `EVT_${ulid()}`;
    const events = new PerformanceEventRepository(prisma);
    await asSupplier(input.organizationId, () =>
      prisma.transaction((tx) =>
        events.record(tx, {
          organizationId: input.organizationId,
          sourceEventId,
          sourceEventName: 'REVIEW_SUBMITTED',
          component: 'CUSTOMER_SATISFACTION',
          outcomeKind: 'ORDER',
          outcomeKey: `ORD_${ulid()}`,
          responsibility: null,
          rating: 4,
          promisedAt: null,
          deliveredAt: null,
          disputeId: null,
          compensatesSourceEventId: null,
          occurredAt: new Date('2026-09-20T00:00:00.000Z'),
          correlationId: ulid(),
        }),
      ),
    );
    return {
      ...input,
      eligibleSampleCount: 1,
      coverageBp: 2000,
      components: input.components.map((row) =>
        row.component === 'CUSTOMER_SATISFACTION'
          ? { ...row, effectiveWeightBp: 10_000, componentScoreCentis: 7500, sampleCount: 1 }
          : row,
      ),
      sourceEventIds: [sourceEventId],
    };
  }

  it('preserves every other scalar, component and nonempty fact provenance field', async () => {
    const input = await withFact();
    await asSupplier(input.organizationId, async () => {
      const id = await prisma.transaction((tx) => snapshots.insert(tx, input));
      const stored = await snapshots.findById(id);
      const { sourceEventIds, components, ...scalars } = input;
      expect(stored).toEqual({
        ...scalars,
        id,
        calculatedAt: expect.any(Date),
        components: expect.arrayContaining(components),
        sourceEvents: sourceEventIds.map((sourceEventId) => ({ sourceEventId })),
      });
      expect(stored?.components).toHaveLength(components.length);
    });
  });

  it('rolls back the snapshot and all components/provenance in the actual caller transaction', async () => {
    const input = await withFact();
    const rollback = new Error('deliberate caller rollback');
    await asSupplier(input.organizationId, async () => {
      await expect(
        prisma.transaction(async (tx) => {
          const id = await snapshots.insert(tx, input);
          expect(await tx.performanceScoreSnapshot.count({ where: { id } })).toBe(1);
          expect(await tx.performanceScoreComponent.count({ where: { snapshotId: id } })).toBe(5);
          expect(await tx.performanceScoreSourceEvent.count({ where: { snapshotId: id } })).toBe(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await snapshots.findLatest()).toBeNull();
      expect(await prisma.client.performanceScoreSnapshot.count()).toBe(0);
      expect(await prisma.client.performanceScoreComponent.count()).toBe(0);
      expect(await prisma.client.performanceScoreSourceEvent.count()).toBe(0);
      expect(await prisma.client.performanceEvent.count()).toBe(1);
    });
  });

  it('refuses missing/mismatched tenants and keeps A/B reads isolated', async () => {
    const a = empty();
    const b = empty();
    const insert = (input: ScoreSnapshotInput): Promise<string> =>
      asSupplier(input.organizationId, () =>
        prisma.transaction((tx) => snapshots.insert(tx, input)),
      );
    const aId = await insert(a);
    const bId = await insert(b);
    for (const [own, ownId, foreignId] of [
      [a, aId, bId],
      [b, bId, aId],
    ] as const) {
      await asSupplier(own.organizationId, async () => {
        expect((await snapshots.findById(ownId))?.organizationId).toBe(own.organizationId);
        expect(await snapshots.findById(foreignId)).toBeNull();
        expect((await snapshots.findLatest())?.id).toBe(ownId);
      });
    }
    await expect(prisma.transaction((tx) => snapshots.insert(tx, empty()))).rejects.toThrow();
    await expect(snapshots.findById(aId)).rejects.toThrow();
    await expect(snapshots.findLatest()).rejects.toThrow();
    await asSupplier(a.organizationId, async () => {
      await expect(prisma.transaction((tx) => snapshots.insert(tx, b))).rejects.toThrow();
      expect(await prisma.client.performanceScoreSnapshot.count()).toBe(1);
    });
    await asSupplier(b.organizationId, async () => {
      expect(await prisma.client.performanceScoreSnapshot.count()).toBe(1);
    });
  });
});
