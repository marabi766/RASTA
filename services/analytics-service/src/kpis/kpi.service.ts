import { Injectable } from '@nestjs/common';
import { DashboardAccess } from '../access/access';
import { KPI_DEFINITIONS } from './definitions';
import { baselineValue, type KpisQuery, type KpisView } from './dto';
import { KpiRepository } from './kpi.repository';

@Injectable()
export class KpiService {
  constructor(
    private readonly access: DashboardAccess,
    private readonly repository: KpiRepository,
  ) {}

  async list(query: KpisQuery): Promise<KpisView> {
    // Same configured readers as the fleet dashboard (ADR-071 § 4); includes the service-level
    // AUDITOR refusal before any read, even if a guard or configuration is miswired.
    const organizationId = this.access.assertCanReadFleet();
    const from = new Date(query.from);
    const to = new Date(query.to);
    const read = await this.repository.read(from, to);
    return {
      organizationId,
      from: from.toISOString(),
      to: to.toISOString(),
      earliestCompletionAt: read.earliest_completion?.toISOString() ?? null,
      kpis: KPI_DEFINITIONS.map((definition) => ({
        key: definition.key,
        unit: definition.unit,
        dependsOnBaseline: definition.dependsOnBaseline,
        ...(definition.dependsOnBaseline
          ? baselineValue(read.baseline_minutes)
          : { status: 'AVAILABLE' as const, value: read.completed_count }),
      })),
    };
  }
}
