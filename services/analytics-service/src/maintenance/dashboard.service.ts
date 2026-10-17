import { Injectable } from '@nestjs/common';
import { DashboardAccess } from '../access/access';
import { MaintenanceFactRepository } from './maintenance-fact.repository';
import type { FleetDashboardQuery, FleetDashboardView } from './dto';
import { toFleetDashboardView } from './views';

/**
 * The fleet dashboard of one organization (`docs/16` § 16.7, ADR-071 § 4), from the facts this
 * service projected — never from another service. Business rules here, not in the controller
 * (AGENTS.md A-10).
 *
 * PR 1 answers the maintenance part only: completions by type with their downtime and cost. It
 * computes **no ratio** — "preventive/emergency" has a name in the documents but no definition
 * (ADR-071, open questions) — and no KPI, so nothing here depends on a baseline.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly access: DashboardAccess,
    private readonly facts: MaintenanceFactRepository,
  ) {}

  async fleet(query: FleetDashboardQuery): Promise<FleetDashboardView> {
    const organizationId = this.access.assertCanReadFleet();
    const from = new Date(query.from);
    const to = new Date(query.to);

    const { rows, earliestCompletion } = await this.facts.fleetMaintenance(from, to);

    return toFleetDashboardView({ organizationId, from, to, earliestCompletion, rows });
  }
}
