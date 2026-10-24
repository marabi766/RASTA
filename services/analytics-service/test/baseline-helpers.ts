import { ulid } from 'ulid';
import type { Prisma } from '../src/generated/prisma';
import { ownerClient } from './helpers';

export const KPI_WINDOW = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

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
