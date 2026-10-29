import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { ENV, LOGGER } from '../tokens';
import { DashboardAccess } from '../access/access';
import type { AnalyticsEnv } from '../config/env';
import { projectionCoversWindow } from './coverage';
import { KPI_DEFINITIONS } from './definitions';
import { baselineValue, kpisViewSchema, type KpiValue, type KpisQuery, type KpisView } from './dto';
import { KpiRepository, type KpiRead } from './kpi.repository';

export const KPI_VALUE_READERS = Symbol('KPI_VALUE_READERS');

/** The read plus the one coverage verdict every projection-backed KPI must honour. */
export interface KpiContext extends KpiRead {
  /** The maintenance projection can vouch for the whole requested window (`coverage.ts`). */
  readonly projection_covers_window: boolean;
}
export type KpiValueReaders = Readonly<Record<string, (read: KpiContext) => KpiValue>>;

/** Explicit dispatch: adding metadata never silently borrows another KPI's value. */
export const kpiValueReaders: KpiValueReaders = {
  // Counting facts is only a statement about the world when the projection saw the whole window
  // (D-082): otherwise "0" would read as "nothing happened" when the truth is "we do not know".
  MAINTENANCE_COMPLETED_COUNT: (read) =>
    read.projection_covers_window
      ? { status: 'AVAILABLE', value: read.completed_count }
      : { status: 'NO_DATA' },
  MAINTENANCE_DOWNTIME_BASELINE_MINUTES: (read) => baselineValue(read.baseline_minutes),
};

@Injectable()
export class KpiService {
  constructor(
    private readonly access: DashboardAccess,
    private readonly repository: KpiRepository,
    @Inject(LOGGER) private readonly logger: Pick<Logger, 'error'>,
    @Inject(ENV)
    private readonly env: Pick<AnalyticsEnv, 'ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED'>,
    @Inject(KPI_VALUE_READERS) private readonly readers: KpiValueReaders = kpiValueReaders,
  ) {}

  async list(query: KpisQuery): Promise<KpisView> {
    // Same configured readers as the fleet dashboard (ADR-071 § 4); includes the service-level
    // AUDITOR refusal before any read, even if a guard or configuration is miswired.
    const organizationId = this.access.assertCanReadFleet();
    const from = new Date(query.from);
    const to = new Date(query.to);
    const raw = await this.repository.read(from, to);
    const read: KpiContext = {
      ...raw,
      projection_covers_window: projectionCoversWindow({
        consumerEnabled: this.env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED,
        coverageStart: raw.coverage_start,
        readAt: raw.read_at,
        from,
        to,
      }),
    };
    const response = {
      organizationId,
      from: from.toISOString(),
      to: to.toISOString(),
      earliestCompletionAt: read.earliest_completion?.toISOString() ?? null,
      kpis: KPI_DEFINITIONS.map((definition) => {
        const evaluate = Object.hasOwn(this.readers, definition.key)
          ? this.readers[definition.key]
          : undefined;
        if (!evaluate) return this.invalidResponse();
        return {
          key: definition.key,
          unit: definition.unit,
          dependsOnBaseline: definition.dependsOnBaseline,
          ...evaluate(read),
        };
      }),
    };
    const parsed = kpisViewSchema.safeParse(response);
    if (!parsed.success) return this.invalidResponse();
    return parsed.data;
  }

  private invalidResponse(): never {
    // Never pass Zod's error, the response, or a cause to the global filter/log.
    this.logger.error({ event: 'KPI_RESPONSE_INVALID' }, 'KPI response validation failed');
    throw new InternalServerErrorException('KPI response unavailable');
  }
}
