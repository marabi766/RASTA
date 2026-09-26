import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { FormulaStatus, PerformanceComponent } from './components';
import type { FormulaDraftInput } from './formula';

/**
 * Reads and writes of the platform-wide performance formula (ADR-052 step 2).
 *
 * ## Every query here crosses the tenant boundary, and says why
 *
 * `PerformanceFormulaVersion` and `PerformanceFormulaWeight` carry no
 * `organizationId` — the formula is one platform-wide configuration read for
 * every supplier in every tenant (docs/24 Q-75). The tenant guard has nothing
 * to scope on these models, so each query runs under `runUnscoped` with that
 * reason anyway: an auditor enumerating the service's boundary crossings
 * should find these too, not infer them from an absence (the precedent is
 * economic-service's `reward_evaluation_cutover`).
 *
 * ## What this class does not decide
 *
 * Whether a caller may change the formula, and whether a draft is valid, are
 * decided before a method here is called (`formula.service.ts`, `formula.ts`).
 * What makes the rules true regardless of caller is the database: the 100%
 * trigger, the single-ACTIVE index and the freeze trigger in
 * `20260926100000_performance_formula_version`.
 */

const PLATFORM_WIDE = 'the performance formula is platform-wide configuration (docs/24 Q-75)';

export interface FormulaVersionRow {
  id: string;
  formulaVersion: number;
  status: FormulaStatus;
  windowDays: number;
  minSampleCount: number;
  minCoverageBp: number;
  ratingScaleMin: number;
  ratingScaleMax: number;
  ratingMinScoreCentis: number;
  ratingMaxScoreCentis: number;
  createdBy: string;
  createdAt: Date;
  activatedBy: string | null;
  activatedAt: Date | null;
  retiredBy: string | null;
  retiredAt: Date | null;
  weights: { component: PerformanceComponent; weightBp: number }[];
}

/** The minimal row a state change locks and reasons about. */
export interface LockedFormulaVersion {
  id: string;
  formulaVersion: number;
  status: FormulaStatus;
}

export interface Stamp {
  by: string;
  at: Date;
  correlationId: string;
}

const WITH_WEIGHTS = {
  weights: {
    select: { component: true, weightBp: true },
    orderBy: { component: 'asc' },
  },
} as const;

@Injectable()
export class PerformanceFormulaRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- writes ---------------------------------------------------------------

  /**
   * The next `formulaVersion`: one above the highest ever recorded.
   *
   * Two concurrent drafts can both read the same maximum; the unique index
   * `ux_performance_formula_version_number` then refuses the second, and the
   * caller reports it as a conflict rather than inventing a number.
   */
  async nextFormulaVersion(tx: ExtendedPrismaClient): Promise<number> {
    const result = await runUnscoped(PLATFORM_WIDE, () =>
      tx.performanceFormulaVersion.aggregate({ _max: { formulaVersion: true } }),
    );
    return (result._max.formulaVersion ?? 0) + 1;
  }

  /**
   * Inserts a DRAFT and its weights in the caller's transaction.
   *
   * The deferred sum trigger checks the weights at commit, so a version and
   * its weights are stored together or not at all.
   */
  async insertDraft(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      formulaVersion: number;
      draft: FormulaDraftInput;
      created: Stamp;
    },
  ): Promise<void> {
    const { draft } = input;
    await runUnscoped(PLATFORM_WIDE, async () => {
      await tx.performanceFormulaVersion.create({
        data: {
          id: input.id,
          formulaVersion: input.formulaVersion,
          windowDays: draft.windowDays,
          minSampleCount: draft.minSampleCount,
          minCoverageBp: draft.minCoverageBp,
          ratingScaleMin: draft.ratingMapping.scaleMin,
          ratingScaleMax: draft.ratingMapping.scaleMax,
          ratingMinScoreCentis: draft.ratingMapping.minScoreCentis,
          ratingMaxScoreCentis: draft.ratingMapping.maxScoreCentis,
          createdBy: input.created.by,
          createdAt: input.created.at,
          createdCorrelationId: input.created.correlationId,
        },
      });
      await tx.performanceFormulaWeight.createMany({
        data: draft.weights.map((weight) => ({
          formulaVersionId: input.id,
          component: weight.component,
          weightBp: weight.weightBp,
        })),
      });
    });
  }

  /**
   * Locks one version for a state change. `null` if it does not exist.
   *
   * `FOR UPDATE` so two activations of the same draft serialise here, and the
   * second sees the status the first committed.
   */
  async lockById(tx: ExtendedPrismaClient, id: string): Promise<LockedFormulaVersion | null> {
    const rows = await tx.$queryRaw<LockedFormulaVersion[]>`
      SELECT "id", "formula_version" AS "formulaVersion", "status"::text AS "status"
        FROM "performance_formula_version"
       WHERE "id" = ${id}
         FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Locks the one ACTIVE version, if there is one. */
  async lockActive(tx: ExtendedPrismaClient): Promise<LockedFormulaVersion | null> {
    const rows = await tx.$queryRaw<LockedFormulaVersion[]>`
      SELECT "id", "formula_version" AS "formulaVersion", "status"::text AS "status"
        FROM "performance_formula_version"
       WHERE "status" = 'ACTIVE'
         FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * ACTIVE → RETIRED. Returns whether the row moved.
   *
   * Only ever called inside an activation: the deferred successor trigger
   * refuses, at commit, a transaction that retires without activating.
   */
  async markRetired(tx: ExtendedPrismaClient, id: string, retired: Stamp): Promise<boolean> {
    const result = await runUnscoped(PLATFORM_WIDE, () =>
      tx.performanceFormulaVersion.updateMany({
        where: { id, status: 'ACTIVE' },
        data: {
          status: 'RETIRED',
          retiredBy: retired.by,
          retiredAt: retired.at,
          retiredCorrelationId: retired.correlationId,
        },
      }),
    );
    return result.count === 1;
  }

  /** DRAFT → ACTIVE. Returns whether the row moved. */
  async markActive(tx: ExtendedPrismaClient, id: string, activated: Stamp): Promise<boolean> {
    const result = await runUnscoped(PLATFORM_WIDE, () =>
      tx.performanceFormulaVersion.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'ACTIVE',
          activatedBy: activated.by,
          activatedAt: activated.at,
          activatedCorrelationId: activated.correlationId,
        },
      }),
    );
    return result.count === 1;
  }

  // -- reads ----------------------------------------------------------------

  async findById(id: string): Promise<FormulaVersionRow | null> {
    return runUnscoped(PLATFORM_WIDE, () =>
      this.prisma.client.performanceFormulaVersion.findUnique({
        where: { id },
        include: WITH_WEIGHTS,
      }),
    );
  }

  /** The formula in force, or `null` before any version has been activated. */
  async findActive(): Promise<FormulaVersionRow | null> {
    return runUnscoped(PLATFORM_WIDE, () =>
      this.prisma.client.performanceFormulaVersion.findFirst({
        where: { status: 'ACTIVE' },
        include: WITH_WEIGHTS,
      }),
    );
  }
}
