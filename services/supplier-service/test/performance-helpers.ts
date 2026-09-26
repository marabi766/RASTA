import { runUnscoped, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { EventPublisher } from '../src/events/publisher';
import type { FormulaDraftInput } from '../src/performance/formula';
import { PerformanceFormulaRepository } from '../src/performance/formula.repository';
import { PerformanceFormulaService } from '../src/performance/formula.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { context, newUserId, testEnv } from './helpers';

/**
 * Shared by the ADR-052 storage suites.
 *
 * ## These tables cannot be cleaned up, and the suites are written for that
 *
 * The formula, the performance events and the snapshots refuse DELETE and
 * TRUNCATE — that is what the suites prove. So nothing here removes a row.
 * Every test makes its own formula numbers, ids and organizations, and no
 * assertion depends on what an earlier test or an earlier run left behind,
 * including which formula version is ACTIVE (AGENTS.md § 5).
 */

export const ADR_052_V1: FormulaDraftInput = {
  windowDays: 180,
  minSampleCount: 5,
  minCoverageBp: 5000,
  ratingMapping: { scaleMin: 1, scaleMax: 5, minScoreCentis: 0, maxScoreCentis: 10_000 },
  weights: [
    { component: 'QUALITY', weightBp: 3000 },
    { component: 'ON_TIME', weightBp: 2500 },
    { component: 'CUSTOMER_SATISFACTION', weightBp: 2000 },
    { component: 'DISPUTE_ABSENCE', weightBp: 1500 },
    { component: 'CANCELLATION_ABSENCE', weightBp: 1000 },
  ],
};

export function raw<T>(fn: () => Promise<T>): Promise<T> {
  return runUnscoped('the storage suites write raw rows on purpose', fn);
}

/** One above the highest formula number anybody has recorded. */
export async function nextFormulaNumber(prisma: PrismaService): Promise<number> {
  const rows = await raw(() =>
    prisma.client.$queryRawUnsafe<{ next: number }[]>(
      'SELECT COALESCE(MAX("formula_version"), 0) + 1 AS "next" FROM "performance_formula_version"',
    ),
  );
  return Number(rows[0]?.next ?? 1);
}

export function versionInsertSql(id: string, formulaVersion: number): string {
  return `
    INSERT INTO "performance_formula_version" (
      "id", "formula_version", "window_days", "min_sample_count", "min_coverage_bp",
      "rating_scale_min", "rating_scale_max", "rating_min_score_centis", "rating_max_score_centis",
      "created_by", "created_correlation_id"
    ) VALUES ('${id}', ${formulaVersion}, 180, 5, 5000, 1, 5, 0, 10000, 'USR_TEST', 'COR_TEST')`;
}

export function weightsInsertSql(
  id: string,
  weights: readonly { component: string; weightBp: number }[],
): string {
  const values = weights.map((w) => `('${id}', '${w.component}', ${w.weightBp})`).join(', ');
  return `INSERT INTO "performance_formula_weight" ("formula_version_id", "component", "weight_bp") VALUES ${values}`;
}

/** Runs statements in one transaction, as the application would. */
export function inOneTransaction(prisma: PrismaService, statements: string[]): Promise<void> {
  return raw(() =>
    prisma.client.$transaction(async (tx) => {
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
    }),
  );
}

/** A committed DRAFT with ADR-052 § 1's weights, written without the service. */
export async function seedDraft(prisma: PrismaService): Promise<{ id: string; number: number }> {
  const id = `PFV_${ulid()}`;
  const number = await nextFormulaNumber(prisma);
  await inOneTransaction(prisma, [
    versionInsertSql(id, number),
    weightsInsertSql(id, ADR_052_V1.weights),
  ]);
  return { id, number };
}

export interface FormulaWiring {
  repository: PerformanceFormulaRepository;
  service: PerformanceFormulaService;
}

export function wireFormula(prisma: PrismaService): FormulaWiring {
  const repository = new PerformanceFormulaRepository(prisma);
  return {
    repository,
    service: new PerformanceFormulaService(prisma, repository, new EventPublisher(testEnv())),
  };
}

/** Runs `fn` as the platform administrator — the only role that may (Q-75). */
export function asSystemAdmin<T>(fn: () => T, userId = newUserId()): T {
  return runWithContext(context({ userId, roles: ['SYSTEM_ADMIN'] }), fn);
}

/** Every outbox row about one aggregate, oldest first. */
export function outboxAbout(prisma: PrismaService, aggregateId: string) {
  return runUnscoped('the outbox carries its own tenant column', () =>
    prisma.client.outboxMessage.findMany({
      where: { aggregateId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
}
