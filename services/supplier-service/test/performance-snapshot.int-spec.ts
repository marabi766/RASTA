import { ulid } from 'ulid';
import type { PerformanceEventInput } from '../src/performance/performance-event';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import type { FormulaDraftInput } from '../src/performance/formula';
import type { ScoreSnapshotInput } from '../src/performance/score-snapshot';
import { ScoreSnapshotRepository } from '../src/performance/score-snapshot.repository';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asSupplier, newOrganizationId, newPrisma } from './helpers';
import {
  ADR_052_V1,
  asSystemAdmin,
  inOneTransaction,
  raw,
  seedDraft,
  wireFormula,
} from './performance-helpers';

/**
 * ADR-052 step 4 — score snapshots, against a real PostgreSQL.
 *
 * Every rule is attacked with raw SQL in one transaction, the way a real
 * write would arrive, so the refusal is the database's — including the
 * provenance checks that only run at commit. The repository path then shows
 * a legitimate snapshot is written, read back whole, and never overwritten.
 */

const APPEND_ONLY = /is append-only/;

interface Version {
  id: string;
  number: number;
}

describe('score snapshots (ADR-052 step 4)', () => {
  let prisma: PrismaService;
  let snapshots: ScoreSnapshotRepository;
  let events: PerformanceEventRepository;
  /** ADR-052 § 1's weights; thresholds 5 samples, 5000 bp. Activated, then retired below. */
  let adr: Version;
  /** A later version weighing only two components — the platform's ACTIVE one after beforeAll. */
  let narrow: Version;

  async function createAndActivate(draft: FormulaDraftInput): Promise<Version> {
    const formula = wireFormula(prisma);
    const created = await asSystemAdmin(() => formula.service.createDraft(draft));
    await asSystemAdmin(() => formula.service.activate(created.id));
    return { id: created.id, number: created.formulaVersion };
  }

  beforeAll(async () => {
    prisma = newPrisma();
    snapshots = new ScoreSnapshotRepository(prisma);
    events = new PerformanceEventRepository(prisma);
    adr = await createAndActivate(ADR_052_V1);
    narrow = await createAndActivate({
      ...ADR_052_V1,
      weights: [
        { component: 'QUALITY', weightBp: 6000 },
        { component: 'CUSTOMER_SATISFACTION', weightBp: 4000 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  function exec(sql: string): Promise<number> {
    return raw(() => prisma.client.$executeRawUnsafe(sql));
  }

  /** Records a real performance fact for `organizationId`, for a snapshot to cite. */
  async function fact(organizationId: string): Promise<string> {
    const input: PerformanceEventInput = {
      organizationId,
      sourceEventId: `EVT_${ulid()}`,
      sourceEventName: 'REVIEW_SUBMITTED',
      component: 'CUSTOMER_SATISFACTION',
      outcomeKind: 'ORDER',
      outcomeKey: `ORD_${ulid()}`,
      responsibility: null,
      rating: 4,
      promisedAt: null,
      deliveredAt: null,
      compensatesSourceEventId: null,
      occurredAt: new Date('2026-09-20T00:00:00.000Z'),
      correlationId: ulid(),
    };
    await asSupplier(organizationId, () => prisma.transaction((tx) => events.record(tx, input)));
    return input.sourceEventId;
  }

  /** A PUBLISHED snapshot of ADR version `adr`: QUALITY absent, the other four at 70%. */
  function published(organizationId: string, sourceEventIds: string[] = []): ScoreSnapshotInput {
    return {
      organizationId,
      formulaVersionId: adr.id,
      formulaVersion: adr.number,
      windowStart: new Date('2026-03-30T00:00:00.000Z'),
      windowEnd: new Date('2026-09-26T00:00:00.000Z'),
      status: 'PUBLISHED',
      scoreCentis: 8750,
      eligibleSampleCount: 7,
      coverageBp: 7000,
      components: [
        {
          component: 'QUALITY',
          configuredWeightBp: 3000,
          effectiveWeightBp: null,
          componentScoreCentis: null,
          sampleCount: 0,
        },
        {
          component: 'ON_TIME',
          configuredWeightBp: 2500,
          effectiveWeightBp: 3571,
          componentScoreCentis: 9000,
          sampleCount: 7,
        },
        {
          component: 'CUSTOMER_SATISFACTION',
          configuredWeightBp: 2000,
          effectiveWeightBp: 2857,
          componentScoreCentis: 8000,
          sampleCount: 6,
        },
        {
          component: 'DISPUTE_ABSENCE',
          configuredWeightBp: 1500,
          effectiveWeightBp: 2143,
          componentScoreCentis: 10000,
          sampleCount: 2,
        },
        {
          component: 'CANCELLATION_ABSENCE',
          configuredWeightBp: 1000,
          effectiveWeightBp: 1429,
          componentScoreCentis: 10000,
          sampleCount: 1,
        },
      ],
      sourceEventIds,
      correlationId: ulid(),
    };
  }

  function insert(input: ScoreSnapshotInput): Promise<string> {
    return asSupplier(input.organizationId, () =>
      prisma.transaction((tx) => snapshots.insert(tx, input)),
    );
  }

  const lit = (value: string | number | null): string =>
    value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value}'`;

  /** The same snapshot as raw SQL statements — bypassing every TypeScript check. */
  function snapshotSql(
    input: ScoreSnapshotInput,
    overrides: Record<string, string> = {},
  ): { id: string; statements: string[] } {
    const id = `PSS_${ulid()}`;
    const columns: Record<string, string> = {
      id: lit(id),
      organization_id: lit(input.organizationId),
      formula_version_id: lit(input.formulaVersionId),
      formula_version: lit(input.formulaVersion),
      window_start: lit(input.windowStart.toISOString()),
      window_end: lit(input.windowEnd.toISOString()),
      status: lit(input.status),
      score_centis: lit(input.scoreCentis),
      eligible_sample_count: lit(input.eligibleSampleCount),
      coverage_bp: lit(input.coverageBp),
      correlation_id: lit(input.correlationId),
      ...overrides,
    };
    const statements = [
      `INSERT INTO "performance_score_snapshot" (${Object.keys(columns)
        .map((c) => `"${c}"`)
        .join(', ')}) VALUES (${Object.values(columns).join(', ')})`,
      ...input.components.map(
        (row) =>
          `INSERT INTO "performance_score_component" VALUES (${lit(input.organizationId)}, ${lit(id)}, ${lit(row.component)}, ${row.configuredWeightBp}, ${lit(row.effectiveWeightBp)}, ${lit(row.componentScoreCentis)}, ${row.sampleCount})`,
      ),
      ...input.sourceEventIds.map(
        (eventId) =>
          `INSERT INTO "performance_score_source_event" VALUES (${lit(input.organizationId)}, ${lit(id)}, ${lit(eventId)})`,
      ),
    ];
    return { id, statements };
  }

  async function snapshotCount(organizationId: string): Promise<number> {
    return raw(() => prisma.client.performanceScoreSnapshot.count({ where: { organizationId } }));
  }

  describe('the legitimate path', () => {
    it('writes a snapshot with its whole provenance and reads it back', async () => {
      const organizationId = newOrganizationId();
      const sources = [await fact(organizationId), await fact(organizationId)];

      const id = await insert(published(organizationId, sources));
      const stored = await asSupplier(organizationId, () => snapshots.findById(id));

      expect(stored).toMatchObject({
        status: 'PUBLISHED',
        scoreCentis: 8750,
        coverageBp: 7000,
        eligibleSampleCount: 7,
        formulaVersion: adr.number,
      });
      expect(stored?.components).toHaveLength(5);
      expect(stored?.components.find((row) => row.component === 'QUALITY')).toMatchObject({
        effectiveWeightBp: null,
        componentScoreCentis: null,
      });
      expect(stored?.sourceEvents.map((row) => row.sourceEventId).sort()).toEqual(
        [...sources].sort(),
      );
    });

    it('adds a new row per computation and leaves the earlier one byte-for-byte as it was', async () => {
      const organizationId = newOrganizationId();
      const first = await insert(published(organizationId));
      const before = JSON.stringify(
        await asSupplier(organizationId, () => snapshots.findById(first)),
      );

      const second = await insert({ ...published(organizationId), scoreCentis: 6000 });

      expect(second).not.toBe(first);
      expect(await snapshotCount(organizationId)).toBe(2);
      expect(
        JSON.stringify(await asSupplier(organizationId, () => snapshots.findById(first))),
      ).toBe(before);
      expect((await asSupplier(organizationId, () => snapshots.findLatest()))?.id).toBe(second);
    });

    it('stays valid, stamped with its version, after that version is retired (ADR-052 § 13)', async () => {
      // `adr` was retired in beforeAll when `narrow` was activated.
      const organizationId = newOrganizationId();
      const id = await insert(published(organizationId));

      expect((await asSupplier(organizationId, () => snapshots.findById(id)))?.formulaVersion).toBe(
        adr.number,
      );
    });
  });

  describe('insert-only, all three tables', () => {
    it.each([
      [
        'performance_score_snapshot',
        `UPDATE "performance_score_snapshot" SET "score_centis" = 1 WHERE "id" = '$ID'`,
      ],
      ['performance_score_snapshot', `DELETE FROM "performance_score_snapshot" WHERE "id" = '$ID'`],
      [
        'performance_score_component',
        `UPDATE "performance_score_component" SET "component_score_centis" = 0 WHERE "snapshot_id" = '$ID'`,
      ],
      [
        'performance_score_component',
        `DELETE FROM "performance_score_component" WHERE "snapshot_id" = '$ID'`,
      ],
      [
        'performance_score_source_event',
        `DELETE FROM "performance_score_source_event" WHERE "snapshot_id" = '$ID'`,
      ],
    ])('refuses rewriting %s', async (_table, sql) => {
      const organizationId = newOrganizationId();
      const id = await insert(published(organizationId, [await fact(organizationId)]));

      await expect(exec(sql.replace('$ID', id))).rejects.toThrow(APPEND_ONLY);
    });

    it.each([
      'performance_score_snapshot',
      'performance_score_component',
      'performance_score_source_event',
    ])('refuses TRUNCATE of %s', async (table) => {
      await expect(exec(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(APPEND_ONLY);
    });

    it('refuses adding provenance to a snapshot committed earlier — it is sealed', async () => {
      const organizationId = newOrganizationId();
      const id = await insert(published(organizationId));
      const late = await fact(organizationId);

      await expect(
        exec(
          `INSERT INTO "performance_score_source_event" VALUES ('${organizationId}', '${id}', '${late}')`,
        ),
      ).rejects.toThrow(/is sealed/);
    });
  });

  describe('a score exists only when PUBLISHED; integers only', () => {
    it('refuses PUBLISHED without a score', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), { score_centis: 'NULL' });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /ck_score_snapshot_score_only_when_published/,
      );
    });

    it.each(['INSUFFICIENT_DATA', 'INSUFFICIENT_COVERAGE'])(
      'refuses a score — even 0 — on %s',
      async (status) => {
        const { statements } = snapshotSql(published(newOrganizationId()), {
          status: `'${status}'`,
          score_centis: '0',
        });

        await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
          /ck_score_snapshot_score_only_when_published/,
        );
      },
    );

    it.each([
      ['a score over 100', { score_centis: '10001' }],
      ['coverage over 100%', { coverage_bp: '10001' }],
      ['a negative sample count', { eligible_sample_count: '-1' }],
    ])('refuses %s', async (_label, overrides) => {
      const { statements } = snapshotSql(published(newOrganizationId()), overrides);

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /ck_score_snapshot_ranges/,
      );
    });

    it('refuses an empty window', async () => {
      const input = published(newOrganizationId());
      const { statements } = snapshotSql(input, {
        window_end: lit(input.windowStart.toISOString()),
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /ck_score_snapshot_window/,
      );
    });

    it('refuses an absent component stored as zero', async () => {
      const input = published(newOrganizationId());
      input.components = input.components.map((row) =>
        row.component === 'QUALITY' ? { ...row, componentScoreCentis: 0 } : row,
      );
      const { statements } = snapshotSql(input);

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /ck_score_component_absent_is_null/,
      );
    });
  });

  describe('the status agrees with its formula version’s thresholds (5 samples, 5000 bp)', () => {
    it('refuses PUBLISHED on four samples', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), {
        eligible_sample_count: '4',
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(/PUBLISHED below/);
    });

    it('refuses PUBLISHED under 50% coverage', async () => {
      const input = published(newOrganizationId());
      // Only satisfaction (2000) and cancellation (1000) available: 30%.
      input.coverageBp = 3000;
      input.components = input.components.map((row) =>
        row.component === 'CUSTOMER_SATISFACTION'
          ? { ...row, effectiveWeightBp: 6667 }
          : row.component === 'CANCELLATION_ABSENCE'
            ? { ...row, effectiveWeightBp: 3333 }
            : { ...row, effectiveWeightBp: null, componentScoreCentis: null },
      );

      await expect(inOneTransaction(prisma, snapshotSql(input).statements)).rejects.toThrow(
        /PUBLISHED below/,
      );
    });

    it('accepts the same 30% as INSUFFICIENT_COVERAGE, with no score', async () => {
      const organizationId = newOrganizationId();
      const input = published(organizationId);
      input.status = 'INSUFFICIENT_COVERAGE';
      input.scoreCentis = null;
      input.coverageBp = 3000;
      input.components = input.components.map((row) =>
        row.component === 'CUSTOMER_SATISFACTION'
          ? { ...row, effectiveWeightBp: 6667 }
          : row.component === 'CANCELLATION_ABSENCE'
            ? { ...row, effectiveWeightBp: 3333 }
            : { ...row, effectiveWeightBp: null, componentScoreCentis: null },
      );

      await insert(input);
      expect(await snapshotCount(organizationId)).toBe(1);
    });

    it('refuses INSUFFICIENT_COVERAGE when coverage meets the threshold', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), {
        status: `'INSUFFICIENT_COVERAGE'`,
        score_centis: 'NULL',
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(/meets the threshold/);
    });

    it('refuses INSUFFICIENT_DATA when the sample meets the minimum', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), {
        status: `'INSUFFICIENT_DATA'`,
        score_centis: 'NULL',
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(/meets the minimum/);
    });

    it('accepts INSUFFICIENT_DATA on four samples, carrying the count', async () => {
      const organizationId = newOrganizationId();
      const id = await insert({
        ...published(organizationId),
        status: 'INSUFFICIENT_DATA',
        scoreCentis: null,
        eligibleSampleCount: 4,
      });

      expect(await asSupplier(organizationId, () => snapshots.findById(id))).toMatchObject({
        status: 'INSUFFICIENT_DATA',
        scoreCentis: null,
        eligibleSampleCount: 4,
      });
    });
  });

  describe('provenance matches the formula version, at commit', () => {
    it('refuses a snapshot of a DRAFT version', async () => {
      const draft = await seedDraft(prisma);
      const { statements } = snapshotSql({
        ...published(newOrganizationId()),
        formulaVersionId: draft.id,
        formulaVersion: draft.number,
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(/DRAFT formula version/);
    });

    it('refuses a formula number that is not its version’s', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), {
        formula_version: String(narrow.number),
      });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /performance_score_snapshot_version_fkey/,
      );
    });

    it('refuses a missing component row', async () => {
      const input = published(newOrganizationId());
      input.components = input.components.filter((row) => row.component !== 'QUALITY');

      await expect(inOneTransaction(prisma, snapshotSql(input).statements)).rejects.toThrow(
        /missing 1/,
      );
    });

    it('refuses a component the version does not weigh', async () => {
      const input: ScoreSnapshotInput = {
        ...published(newOrganizationId()),
        formulaVersionId: narrow.id,
        formulaVersion: narrow.number,
        coverageBp: 10_000,
        components: [
          {
            component: 'QUALITY',
            configuredWeightBp: 6000,
            effectiveWeightBp: 6000,
            componentScoreCentis: 9000,
            sampleCount: 5,
          },
          {
            component: 'CUSTOMER_SATISFACTION',
            configuredWeightBp: 4000,
            effectiveWeightBp: 4000,
            componentScoreCentis: 8000,
            sampleCount: 5,
          },
          {
            component: 'ON_TIME',
            configuredWeightBp: 2500,
            effectiveWeightBp: null,
            componentScoreCentis: null,
            sampleCount: 0,
          },
        ],
      };

      await expect(inOneTransaction(prisma, snapshotSql(input).statements)).rejects.toThrow(
        /extra 1/,
      );
    });

    it('refuses a configured weight that is not the version’s', async () => {
      const input = published(newOrganizationId());
      input.components = input.components.map((row) =>
        row.component === 'QUALITY' ? { ...row, configuredWeightBp: 2999 } : row,
      );

      await expect(inOneTransaction(prisma, snapshotSql(input).statements)).rejects.toThrow(
        /wrong weight 1/,
      );
    });

    it('refuses a coverage that is not the weight of the available components', async () => {
      const { statements } = snapshotSql(published(newOrganizationId()), { coverage_bp: '7500' });

      await expect(inOneTransaction(prisma, statements)).rejects.toThrow(
        /its available components weigh 7000 bp/,
      );
    });

    it('refuses an effective weight that is not the renormalised configured weight', async () => {
      const input = published(newOrganizationId());
      input.components = input.components.map((row) =>
        row.component === 'ON_TIME' ? { ...row, effectiveWeightBp: 2500 } : row,
      );

      await expect(inOneTransaction(prisma, snapshotSql(input).statements)).rejects.toThrow(
        /not the renormalised/,
      );
    });
  });

  describe('tenant isolation', () => {
    it('refuses citing another supplier’s performance event', async () => {
      const a = newOrganizationId();
      const foreign = await fact(newOrganizationId());

      await expect(
        inOneTransaction(prisma, snapshotSql(published(a, [foreign])).statements),
      ).rejects.toThrow(/performance_score_source_event_event_fkey/);
    });

    it('never shows one supplier another’s snapshot', async () => {
      const a = newOrganizationId();
      const b = newOrganizationId();
      const own = await insert(published(a));
      const theirs = await insert(published(b));

      expect(await asSupplier(a, () => snapshots.findById(theirs))).toBeNull();
      expect((await asSupplier(a, () => snapshots.findLatest()))?.id).toBe(own);
    });

    it('refuses writing another tenant’s snapshot from this tenant’s context', async () => {
      const a = newOrganizationId();
      const b = newOrganizationId();

      await expect(
        asSupplier(a, () => prisma.transaction((tx) => snapshots.insert(tx, published(b)))),
      ).rejects.toThrow(/Cross-tenant writes are never implicit/);
      expect(await snapshotCount(b)).toBe(0);
    });
  });
});
