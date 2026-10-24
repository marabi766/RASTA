import { Injectable } from '@nestjs/common';
import { getOrganizationId } from '@rasta/nest-common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { KPI_DEFINITIONS } from './definitions';

const readSchema = z.object({
  completed_count: z.string().regex(/^\d+$/),
  earliest_completion: z.date().nullable(),
  baseline_minutes: z.string().regex(/^\d+$/).nullable(),
});
export type KpiRead = z.infer<typeof readSchema>;

/** Reads only. Q-142 (1) forbids any application writer, including seed or scheduled work. */
@Injectable()
export class KpiRepository {
  constructor(private readonly prisma: PrismaService) {}

  async read(from: Date, to: Date): Promise<KpiRead> {
    const organizationId = getOrganizationId();
    const baseline = KPI_DEFINITIONS.find(
      (definition) => definition.key === 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
    );
    if (!baseline) throw new Error('Required baseline definition is missing');
    // Raw SQL is outside the tenant extension: EVERY table read has its own tenant predicate
    // from the active context, never a caller argument. One statement gives one snapshot.
    // No sums through Prisma's bigint decoder; count and baseline are exact decimal strings.
    const [row] = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT
        (SELECT count(*)::text FROM fact_maintenance
          WHERE organization_id = ${organizationId}
            AND completed_at >= ${from}::timestamptz
            AND completed_at < ${to}::timestamptz) AS completed_count,
        (SELECT min(completed_at) FROM fact_maintenance
          WHERE organization_id = ${organizationId}) AS earliest_completion,
        (SELECT value::text FROM baseline_metric
          WHERE organization_id = ${organizationId}
            AND metric_key = ${baseline.key}
            AND scope_kind = 'ORGANIZATION'
            AND period_start = ${from}::timestamptz
            AND period_end = ${to}::timestamptz
            AND unit = ${baseline.unit}
            AND COALESCE(currency, '') = ''
          ORDER BY version DESC
          LIMIT 1) AS baseline_minutes`;
    return readSchema.parse(row);
  }
}
