import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { MaintenanceRepository } from './maintenance.repository';

/**
 * Whether a repair is in progress on a machine, as maintenance-service
 * records it (D-039).
 *
 * "In maintenance" is what `MAINTENANCE_STARTED` announces and
 * `MAINTENANCE_COMPLETED` ends: a repair order that is `IN_PROGRESS`.
 * fleet-service's `inMaintenance` flag (which gates dispatch) and
 * asset-service's `IN_MAINTENANCE` status follow it. When one of those events
 * is replayed on `.retry` it may be older than what was applied since, so the
 * consumer does not apply its payload: it asks here for the current answer.
 *
 * The ADR-061 § 4 pattern: `/v1/internal/…`, which the gateway routes
 * nowhere; `@AllowService` on the route and {@link assertWorkStateCaller}
 * here, which also refuses every user token; the organization is the one
 * signed into the internal token (ADR-035), never a header. A repair in
 * another organization is not visible, so it is never counted.
 */

/** The only callers: the services that mirror the machine's maintenance state. */
export const WORK_STATE_CALLERS = ['fleet-service', 'asset-service'] as const;

export interface MaintenanceStateView {
  assetId: string;
  inMaintenance: boolean;
}

export function assertWorkStateCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    !(WORK_STATE_CALLERS as readonly string[]).includes(context.callerService ?? '')
  ) {
    throw RastaError.forbidden('This endpoint is reserved for fleet-service and asset-service');
  }
}

@Injectable()
export class AssetWorkStateService {
  constructor(private readonly repository: MaintenanceRepository) {}

  async maintenanceState(assetId: string): Promise<MaintenanceStateView> {
    assertWorkStateCaller();
    // A token with no organization is a 403 here, before any query.
    getOrganizationId();
    return { assetId, inMaintenance: await this.repository.hasRepairInProgress(assetId) };
  }
}
