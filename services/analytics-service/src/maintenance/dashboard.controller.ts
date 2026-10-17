import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { DashboardService } from './dashboard.service';
import { fleetDashboardQuerySchema, type FleetDashboardQuery } from './dto';

const READERS_NOTE =
  'Closed by default (S-02). Read for the organization the request acts for — the roles of ' +
  'ANALYTICS_FLEET_DASHBOARD_ROLES (default ORGANIZATION_ADMIN, FLEET_MANAGER), and SYSTEM_ADMIN ' +
  'acting for an organization it selected with X-Organization-Id. AUDITOR is refused: it reads ' +
  'aggregate governance views only, and one organization’s dashboard is that organization’s ' +
  'detail. A service token is refused. Built from the events this service received, never from ' +
  'another service’s database (ADR-071).';

/**
 * The tenant dashboards. HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 *
 * No handler names a role: who may read is configuration (`DashboardAccess`), and a decorator
 * would be fixed at compile time. The global guards still demand a token on every route.
 */
@ApiTags('dashboards')
@Controller({ path: 'dashboards', version: '1' })
export class DashboardController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get('fleet')
  @ApiOperation({
    summary: 'The fleet dashboard of the organization the request acts for',
    description:
      'Completed maintenance in [from, to), by type: how many, the downtime of those whose ' +
      'downtime is known (the rest are not counted as zero), and the cost per currency in minor ' +
      'units as decimal strings. No ratio is computed. `earliestCompletionAt` says from when this ' +
      `service holds facts at all. ${READERS_NOTE}`,
  })
  async fleet(@Query(zodPipe(fleetDashboardQuerySchema)) query: FleetDashboardQuery) {
    return this.dashboards.fleet(query);
  }
}
