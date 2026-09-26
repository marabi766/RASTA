import { runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { PrismaService } from '../src/prisma/prisma.service';
import { context, newOrganizationId, newPrisma, newUserId } from './helpers';
import {
  ADR_052_V1,
  asSystemAdmin,
  inOneTransaction,
  nextFormulaNumber,
  outboxAbout,
  raw,
  seedDraft,
  versionInsertSql,
  weightsInsertSql,
  wireFormula,
  type FormulaWiring,
  ownerPrisma,
} from './performance-helpers';

/**
 * ADR-052 step 2 — the formula version and its weights, against a real
 * PostgreSQL.
 *
 * Each rule is proved by trying to break it with raw SQL, not through the
 * service: a rule that holds only because today's only caller is polite is
 * not a database rule (ADR-052 § 24). The service half then shows the one
 * legitimate path writes its audit event in the same transaction.
 */

const SUM_REFUSED = /exactly 10000 bp is required/;
const FROZEN = /is never edited|are frozen/;

describe('performance formula storage (ADR-052 step 2)', () => {
  let prisma: PrismaService;
  /** The schema owner — the trigger attacks run as it (see `ownerPrisma`). */
  let owner: PrismaService;
  let formula: FormulaWiring;

  beforeAll(() => {
    prisma = newPrisma();
    owner = ownerPrisma();
    formula = wireFormula(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  function exec(sql: string): Promise<number> {
    return raw(() => owner.client.$executeRawUnsafe(sql));
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const rows = await raw(() =>
      prisma.client.$queryRawUnsafe<{ status: string }[]>(
        `SELECT "status"::text AS "status" FROM "performance_formula_version" WHERE "id" = '${id}'`,
      ),
    );
    return rows[0]?.status;
  }

  /** Activates through the service, so the platform always keeps one ACTIVE. */
  function activate(id: string) {
    return asSystemAdmin(() => formula.service.activate(id));
  }

  describe('the 100% rule is the database’s, checked at commit', () => {
    it('refuses weights one basis point short', async () => {
      const id = `PFV_${ulid()}`;
      const weights = ADR_052_V1.weights.map((w) =>
        w.component === 'CANCELLATION_ABSENCE' ? { ...w, weightBp: 999 } : w,
      );

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)),
          weightsInsertSql(id, weights),
        ]),
      ).rejects.toThrow(SUM_REFUSED);
      expect(await statusOf(id)).toBeUndefined();
    });

    it('refuses weights one basis point over', async () => {
      const id = `PFV_${ulid()}`;
      const weights = ADR_052_V1.weights.map((w) =>
        w.component === 'QUALITY' ? { ...w, weightBp: 3001 } : w,
      );

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)),
          weightsInsertSql(id, weights),
        ]),
      ).rejects.toThrow(SUM_REFUSED);
    });

    it('refuses a version stored with no weights at all', async () => {
      const id = `PFV_${ulid()}`;

      await expect(exec(versionInsertSql(id, await nextFormulaNumber(prisma)))).rejects.toThrow(
        SUM_REFUSED,
      );
      expect(await statusOf(id)).toBeUndefined();
    });

    it('refuses breaking the sum of a stored DRAFT afterwards', async () => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(
          `DELETE FROM "performance_formula_weight" WHERE "formula_version_id" = '${id}' AND "component" = 'QUALITY'`,
        ),
      ).rejects.toThrow(SUM_REFUSED);
    });

    it('lets a DRAFT be re-weighted when the transaction ends at exactly 100%', async () => {
      const { id } = await seedDraft(prisma);

      await inOneTransaction(owner, [
        `UPDATE "performance_formula_weight" SET "weight_bp" = 2500 WHERE "formula_version_id" = '${id}' AND "component" = 'QUALITY'`,
        `UPDATE "performance_formula_weight" SET "weight_bp" = 3000 WHERE "formula_version_id" = '${id}' AND "component" = 'ON_TIME'`,
      ]);
    });

    it.each([0, 10_001, -1])('refuses a single weight of %s bp', async (weightBp) => {
      const id = `PFV_${ulid()}`;

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)),
          weightsInsertSql(id, [
            { component: 'QUALITY', weightBp },
            { component: 'ON_TIME', weightBp: 10_000 - weightBp },
          ]),
        ]),
      ).rejects.toThrow(/ck_formula_weight_bp_range/);
    });

    it('refuses the same component weighted twice', async () => {
      const id = `PFV_${ulid()}`;

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)),
          weightsInsertSql(id, [
            { component: 'QUALITY', weightBp: 5000 },
            { component: 'QUALITY', weightBp: 5000 },
          ]),
        ]),
      ).rejects.toThrow(/Key \(formula_version_id, component\)=.* already exists/);
    });

    it('refuses a component outside the closed set', async () => {
      const id = `PFV_${ulid()}`;

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)),
          weightsInsertSql(id, [{ component: 'PRICE', weightBp: 10_000 }]),
        ]),
      ).rejects.toThrow(/invalid input value for enum/);
    });
  });

  describe('the version row', () => {
    it('refuses a duplicate formula number', async () => {
      const { number } = await seedDraft(prisma);
      const id = `PFV_${ulid()}`;

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, number),
          weightsInsertSql(id, ADR_052_V1.weights),
        ]),
      ).rejects.toThrow(/Key \(formula_version\)=.* already exists/);
    });

    it.each([
      ['a zero window', '"window_days" = 0', 'ck_formula_window_positive'],
      ['a zero minimum sample', '"min_sample_count" = 0', 'ck_formula_min_sample_positive'],
      [
        'a coverage threshold over 100%',
        '"min_coverage_bp" = 10001',
        'ck_formula_min_coverage_range',
      ],
      [
        'a mapping where a better rating scores lower',
        '"rating_min_score_centis" = 10000, "rating_max_score_centis" = 0',
        'ck_formula_rating_mapping',
      ],
    ])('refuses %s', async (_label, assignment, constraint) => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(`UPDATE "performance_formula_version" SET ${assignment} WHERE "id" = '${id}'`),
      ).rejects.toThrow(new RegExp(constraint));
    });

    it('refuses a blank actor — a tab is not a name', async () => {
      const id = `PFV_${ulid()}`;

      await expect(
        inOneTransaction(owner, [
          versionInsertSql(id, await nextFormulaNumber(prisma)).replace("'USR_TEST'", "E'\\t'"),
          weightsInsertSql(id, ADR_052_V1.weights),
        ]),
      ).rejects.toThrow(/ck_formula_text_not_blank/);
    });

    it('refuses ACTIVE without its three activation stamps', async () => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(`UPDATE "performance_formula_version" SET "status" = 'ACTIVE' WHERE "id" = '${id}'`),
      ).rejects.toThrow(/ck_formula_status_stamps/);
    });

    it('refuses DRAFT → RETIRED: nothing retires what was never in force', async () => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(
          `UPDATE "performance_formula_version" SET "status" = 'RETIRED', "activated_by" = 'U', "activated_at" = now(), "activated_correlation_id" = 'C', "retired_by" = 'U', "retired_at" = now(), "retired_correlation_id" = 'C' WHERE "id" = '${id}'`,
        ),
      ).rejects.toThrow(/may go from DRAFT only to ACTIVE/);
    });

    it('refuses renumbering even a DRAFT', async () => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(
          `UPDATE "performance_formula_version" SET "formula_version" = "formula_version" + 100000 WHERE "id" = '${id}'`,
        ),
      ).rejects.toThrow(/formula_version is fixed at creation/);
    });
  });

  describe('exactly one ACTIVE version, and it is never edited', () => {
    it('refuses a second ACTIVE version', async () => {
      const first = await seedDraft(prisma);
      await activate(first.id);
      const second = await seedDraft(prisma);

      await expect(
        exec(
          `UPDATE "performance_formula_version" SET "status" = 'ACTIVE', "activated_by" = 'U', "activated_at" = now(), "activated_correlation_id" = 'C' WHERE "id" = '${second.id}'`,
        ),
      ).rejects.toThrow(/Key \(status\)=\(ACTIVE\) already exists/);
    });

    it.each([
      ['its window', '"window_days" = 90'],
      ['its coverage threshold', '"min_coverage_bp" = 4000'],
      ['its rating mapping', '"rating_max_score_centis" = 9000'],
      ['its activation stamp', `"activated_by" = 'SOMEBODY_ELSE'`],
      [
        'its status back to DRAFT',
        `"status" = 'DRAFT', "activated_by" = NULL, "activated_at" = NULL, "activated_correlation_id" = NULL`,
      ],
    ])('refuses editing %s once ACTIVE', async (_label, assignment) => {
      const { id } = await seedDraft(prisma);
      await activate(id);

      await expect(
        exec(`UPDATE "performance_formula_version" SET ${assignment} WHERE "id" = '${id}'`),
      ).rejects.toThrow(FROZEN);
    });

    it.each([
      [
        're-weighted',
        `UPDATE "performance_formula_weight" SET "weight_bp" = "weight_bp" WHERE "formula_version_id" = '$ID'`,
      ],
      [
        'given a new component row',
        `INSERT INTO "performance_formula_weight" VALUES ('$ID', 'QUALITY', 1)`,
      ],
      [
        'stripped of a weight',
        `DELETE FROM "performance_formula_weight" WHERE "formula_version_id" = '$ID'`,
      ],
    ])('refuses an ACTIVE version’s weights being %s', async (_label, sql) => {
      const { id } = await seedDraft(prisma);
      await activate(id);

      await expect(exec(sql.replace('$ID', id))).rejects.toThrow(FROZEN);
    });

    it('refuses a standalone retirement, at commit — only a successor retires it', async () => {
      const { id } = await seedDraft(prisma);
      await activate(id);

      await expect(
        exec(
          `UPDATE "performance_formula_version" SET "status" = 'RETIRED', "retired_by" = 'U', "retired_at" = now(), "retired_correlation_id" = 'C' WHERE "id" = '${id}'`,
        ),
      ).rejects.toThrow(/retired without a successor/);
      expect(await statusOf(id)).toBe('ACTIVE');
    });

    it('never edits or revives a RETIRED version', async () => {
      const retired = await seedDraft(prisma);
      await activate(retired.id);
      await activate((await seedDraft(prisma)).id);
      expect(await statusOf(retired.id)).toBe('RETIRED');

      await expect(
        exec(
          `UPDATE "performance_formula_version" SET "status" = 'ACTIVE', "retired_by" = NULL, "retired_at" = NULL, "retired_correlation_id" = NULL WHERE "id" = '${retired.id}'`,
        ),
      ).rejects.toThrow(FROZEN);
      await expect(
        exec(
          `UPDATE "performance_formula_weight" SET "weight_bp" = "weight_bp" WHERE "formula_version_id" = '${retired.id}'`,
        ),
      ).rejects.toThrow(FROZEN);
    });
  });

  describe('nothing is ever deleted', () => {
    it('refuses deleting a version, even a DRAFT', async () => {
      const { id } = await seedDraft(prisma);

      await expect(
        exec(`DELETE FROM "performance_formula_version" WHERE "id" = '${id}'`),
      ).rejects.toThrow(/is never deleted/);
    });

    it.each(['performance_formula_version', 'performance_formula_weight'])(
      'refuses TRUNCATE of %s',
      async (table) => {
        await seedDraft(prisma);

        await expect(exec(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/never truncated/);
      },
    );
  });

  describe('the one legitimate path — the domain service', () => {
    it('records a DRAFT and announces it in the same transaction, with no tenant', async () => {
      const actor = newUserId();
      const created = await asSystemAdmin(() => formula.service.createDraft(ADR_052_V1), actor);

      expect(created).toMatchObject({ status: 'DRAFT', createdBy: actor, windowDays: 180 });
      expect(created.weights).toHaveLength(5);

      const [event, ...rest] = await outboxAbout(prisma, created.id);
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        eventName: 'PERFORMANCE_FORMULA_VERSION_CREATED',
        aggregateType: 'PerformanceFormulaVersion',
        partitionKey: created.id,
        organizationId: null,
        topic: 'rasta.supplier.v1',
      });
      const envelope = event?.payload as { tenantId?: string; payload: Record<string, unknown> };
      expect(envelope).not.toHaveProperty('tenantId');
      expect(envelope.payload).toMatchObject({
        formulaVersionId: created.id,
        formulaVersion: created.formulaVersion,
        createdBy: actor,
        createdAt: created.createdAt.toISOString(),
      });
    });

    it('activates a DRAFT, retires its predecessor, and audits both', async () => {
      const previous = await asSystemAdmin(() => formula.service.createDraft(ADR_052_V1));
      await asSystemAdmin(() => formula.service.activate(previous.id));
      const next = await asSystemAdmin(() => formula.service.createDraft(ADR_052_V1));
      const actor = newUserId();

      const active = await asSystemAdmin(() => formula.service.activate(next.id), actor);

      expect(active).toMatchObject({ status: 'ACTIVE', activatedBy: actor });
      expect(await statusOf(previous.id)).toBe('RETIRED');
      expect((await formula.repository.findActive())?.id).toBe(next.id);

      const retiredEvents = (await outboxAbout(prisma, previous.id)).map((row) => row.eventName);
      expect(retiredEvents).toEqual([
        'PERFORMANCE_FORMULA_VERSION_CREATED',
        'PERFORMANCE_FORMULA_VERSION_ACTIVATED',
        'PERFORMANCE_FORMULA_VERSION_RETIRED',
      ]);
      const activated = (await outboxAbout(prisma, next.id)).at(-1);
      expect(activated?.eventName).toBe('PERFORMANCE_FORMULA_VERSION_ACTIVATED');
      expect((activated?.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
        supersededFormulaVersionId: previous.id,
        activatedBy: actor,
      });
      const retired = (await outboxAbout(prisma, previous.id)).at(-1);
      expect((retired?.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
        successorFormulaVersionId: next.id,
        retiredBy: actor,
      });
    });

    it('refuses activating a version twice, and writes nothing the second time', async () => {
      const draft = await asSystemAdmin(() => formula.service.createDraft(ADR_052_V1));
      await asSystemAdmin(() => formula.service.activate(draft.id));
      const before = (await outboxAbout(prisma, draft.id)).length;

      await expect(asSystemAdmin(() => formula.service.activate(draft.id))).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(await outboxAbout(prisma, draft.id)).toHaveLength(before);
    });

    it('answers 404 for a version that does not exist', async () => {
      await expect(
        asSystemAdmin(() => formula.service.activate(`PFV_${ulid()}`)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses an invalid draft before touching the database', async () => {
      const number = await nextFormulaNumber(prisma);

      await expect(
        asSystemAdmin(() =>
          formula.service.createDraft({
            ...ADR_052_V1,
            weights: [{ component: 'QUALITY', weightBp: 9999 }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await nextFormulaNumber(prisma)).toBe(number);
    });

    it('refuses UNION_ADMIN (docs/24 Q-75) and writes nothing', async () => {
      const number = await nextFormulaNumber(prisma);
      const asUnionAdmin = <T>(fn: () => T): T =>
        runWithContext(
          context({
            userId: newUserId(),
            organizationId: newOrganizationId(),
            roles: ['UNION_ADMIN'],
          }),
          fn,
        );

      await expect(
        asUnionAdmin(() => formula.service.createDraft(ADR_052_V1)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const { id } = await seedDraft(prisma);
      await expect(asUnionAdmin(() => formula.service.activate(id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      expect(await nextFormulaNumber(prisma)).toBe(number + 1);
      expect(await statusOf(id)).toBe('DRAFT');
    });
  });
});
