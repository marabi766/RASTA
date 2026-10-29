import { ulid } from 'ulid';
import type { Prisma } from '../src/generated/prisma';
import { ownerClient } from './helpers';

// A window that has ENDED for good: a KPI window reaching into the future is NO_DATA (Q-154), so a
// fixture window that is open today would make every AVAILABLE assertion depend on the date.
export const KPI_WINDOW = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' };
/** A coverage start safely before `KPI_WINDOW.from`. */
export const COVERED_SINCE = new Date('2026-01-01T00:00:00.000Z');

/** Synthetic measurements for isolated tests only; never a demo/production seed. */
export function baselineFixture(
  organizationId: string,
  overrides: Partial<Prisma.BaselineMetricCreateInput> = {},
): Prisma.BaselineMetricCreateInput {
  return {
    organizationId,
    id: ulid(),
    metricKey: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
    scopeKind: 'ORGANIZATION',
    periodStart: new Date(KPI_WINDOW.from),
    periodEnd: new Date(KPI_WINDOW.to),
    value: 600n,
    unit: 'MINUTES',
    currency: null,
    source: 'synthetic-test-measurement',
    recordedBy: 'test-fixture',
    ...overrides,
  };
}

export async function cleanupBaselines(organizationIds: string[]): Promise<void> {
  const owner = ownerClient();
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric DISABLE TRIGGER tg_baseline_metric_append_only',
      );
      await tx.baselineMetric.deleteMany({ where: { organizationId: { in: organizationIds } } });
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric ENABLE TRIGGER tg_baseline_metric_append_only',
      );
    });
  } finally {
    await owner.$disconnect();
  }
}
