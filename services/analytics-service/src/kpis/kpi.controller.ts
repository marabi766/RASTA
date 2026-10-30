import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { kpisQuerySchema, type KpisQuery, type KpisView } from './dto';
import { KpiService } from './kpi.service';

@ApiTags('kpis')
@Controller({ path: 'kpis', version: '1' })
export class KpiController {
  constructor(private readonly kpis: KpiService) {}

  @Get()
  @ApiOperation({
    summary: 'KPIs for the active organization in [from, to)',
    description:
      'Same configured readers as the fleet dashboard (ANALYTICS_FLEET_DASHBOARD_ROLES), plus ' +
      'SYSTEM_ADMIN acting for one organization. AUDITOR and service tokens are refused. ' +
      'Completed-maintenance count and the recorded downtime baseline itself, without a savings ' +
      'or avoided-downtime formula. Baseline matching requires this organization, ORGANIZATION ' +
      'scope, metric key, unit, no currency and the exact requested period. ' +
      'latest = highest database identity (version), not commit order; a future writer (Q-142) ' +
      'must serialize writes per (org, key, scope, unit, currency, period). ' +
      'Missing or mismatched baseline: INSUFFICIENT_BASELINE with value null, never ' +
      'zero or an estimate. The count is AVAILABLE only when the maintenance projection covers ' +
      'the whole window; otherwise NO_DATA with no value field (D-082): analytics cannot vouch ' +
      'for the window, which is not zero. AVAILABLE values are exact decimal strings. No parameter selects ' +
      'organization, subtree or scope. No baseline writer or seed (Q-142 (1)).',
  })
  async list(@Query(zodPipe(kpisQuerySchema)) query: KpisQuery): Promise<KpisView> {
    return this.kpis.list(query);
  }
}
