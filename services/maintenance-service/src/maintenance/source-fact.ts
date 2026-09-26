import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { MaintenanceRepository } from './maintenance.repository';

/**
 * The maintenance request as its owner states it, for the one consumer that
 * makes money from maintenance events (ADR-061 § 4).
 *
 * ## Why this exists
 *
 * A Kafka message is its publisher's claim, not a fact. Until the broker
 * authenticates publishers, anything that reaches it can write
 * `MAINTENANCE_APPROVED` for any organization and any amount. economic-service
 * turns that event into a settleable obligation, so before it does, it asks
 * this service whether the approval is real and what it says. This read is the
 * answer, and this service's database is the only authority for it.
 *
 * ## The lock
 *
 * - `/v1/internal/…`, a first path segment the gateway routes nowhere, so
 *   nothing outside the cluster reaches it.
 * - `@AllowService` on the route, and {@link assertSourceFactCaller} here,
 *   which also refuses every *user* token. The auth guard admits a verified
 *   user to any authenticated route, so `@AllowService` alone would not.
 * - The tenant is the one **signed into** the internal token (ADR-035), never a
 *   header. A token with no organization is refused; a request in another
 *   organization is not found, so the caller learns nothing about it.
 *
 * ## What it returns
 *
 * Only the fields a financial consumer compares or a reward rule reads: no
 * title, description, notes or reporter. Amounts are strings in minor units,
 * as everywhere else on the platform.
 */

/** The only caller this read answers. */
export const SOURCE_FACT_CALLER = 'economic-service';

export const requestIdParamSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface MaintenanceRequestFactView {
  id: string;
  organizationId: string;
  assetId: string;
  type: string;
  scheduleId: string | null;
  status: string;
  completedAt: string | null;
  completedBy: string | null;
  downtimeMinutes: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  totalCostMinor: string;
  currency: string;
  /**
   * The workshop the approval settles with. The same rule the approval used
   * when it published `MAINTENANCE_APPROVED`: `null` for work no outside
   * workshop completed.
   */
  workshopOrganizationId: string | null;
}

export function assertSourceFactCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== SOURCE_FACT_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the settlement consumer');
  }
}

@Injectable()
export class MaintenanceFactService {
  constructor(private readonly repository: MaintenanceRepository) {}

  async requestFact(id: string): Promise<MaintenanceRequestFactView> {
    assertSourceFactCaller();
    // Resolved before the read, so a token minted with no organization fails
    // here as a 403 and never reaches a query.
    getOrganizationId();

    const request = await this.repository.findRequestById(id);
    if (!request) throw RastaError.notFound('MaintenanceRequest', id);

    const workshopOrganizationId = await this.repository.findSettlingWorkshop(
      this.repository.client,
      id,
    );

    return {
      id: request.id,
      organizationId: request.organizationId,
      assetId: request.assetId,
      type: request.type,
      scheduleId: request.scheduleId,
      status: request.status,
      completedAt: request.completedAt?.toISOString() ?? null,
      completedBy: request.completedBy,
      downtimeMinutes: request.downtimeMinutes,
      approvedAt: request.approvedAt?.toISOString() ?? null,
      approvedBy: request.approvedBy,
      totalCostMinor: request.totalCostMinor.toString(),
      currency: request.currency,
      workshopOrganizationId,
    };
  }
}
