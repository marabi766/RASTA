import { Injectable } from '@nestjs/common';
import { getOrganizationId } from '@rasta/nest-common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MAINTENANCE_FACTS_CONSUMER } from '../maintenance/maintenance-fact';
import { KPI_DEFINITIONS } from './definitions';

const readSchema = z.object({
  completed_count: z.string().regex(/^\d+$/),
  earliest_completion: z.date().nullable(),
  baseline_minutes: z.string().regex(/^\d+$/).nullable(),
  /** When the maintenance projection first ran successfully; null = it never has. */
  coverage_start: z.date().nullable(),
  /** The database clock of this very read, from the same statement as everything above. */
  read_at: z.date(),
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
    // from the active context, never a caller argument — except `projection_coverage`, which is
    // deployment-wide and has no organization column (consumption is not per tenant, Q-154).
    // One statement gives one snapshot: the count, the coverage start and the read instant can
    // never disagree about a concurrent commit.
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
          LIMIT 1) AS baseline_minutes,
        (SELECT covered_from FROM projection_coverage
          WHERE consumer_name = ${MAINTENANCE_FACTS_CONSUMER}) AS coverage_start,
        statement_timestamp() AS read_at`;
    return readSchema.parse(row);
  }
}
