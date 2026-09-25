import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { FleetRepository } from './fleet.repository';

/**
 * A usage record as its owner states it, for the one consumer that rewards
 * usage (ADR-061 § 4).
 *
 * economic-service grants rewards on `USAGE_RECORDED`, and a reward rule can be
 * monetised. The event is its publisher's claim: until the broker
 * authenticates publishers, anything that reaches it can name any subject in
 * `actor` and any organization in the payload. So economic-service reads the
 * record here instead. The organization is the record's own, the subject is
 * the user who recorded it (`recordedBy`), and the quantities are the ones
 * this service stored.
 *
 * The lock is the same as maintenance-service's `source-fact.ts`:
 * `/v1/internal/…` (the gateway routes nowhere there), `@AllowService`, a
 * check that refuses user tokens as well, and the tenant signed into the
 * internal token (ADR-035). A record in another organization is not found.
 */

/** The only caller this read answers. */
export const SOURCE_FACT_CALLER = 'economic-service';

export const usageRecordIdParamSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface UsageRecordFactView {
  id: string;
  organizationId: string;
  assetId: string;
  driverId: string | null;
  assignmentId: string | null;
  periodStart: string;
  periodEnd: string;
  /** NUMERIC as a string, never a float. */
  hours: string | null;
  kilometres: string | null;
  hourMeter: string | null;
  odometer: string | null;
  source: string;
  recordedAt: string;
  /** The user who recorded it, or `SYSTEM` for a write with no user. */
  recordedBy: string;
}

export function assertSourceFactCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== SOURCE_FACT_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the reward consumer');
  }
}

@Injectable()
export class UsageFactService {
  constructor(private readonly repository: FleetRepository) {}

  async usageFact(id: string): Promise<UsageRecordFactView> {
    assertSourceFactCaller();
    // A token minted with no organization is a 403 here, before any query.
    getOrganizationId();

    const record = await this.repository.findUsageById(id);
    if (!record) throw RastaError.notFound('UsageRecord', id);

    return {
      id: record.id,
      organizationId: record.organizationId,
      assetId: record.assetId,
      driverId: record.driverId,
      assignmentId: record.assignmentId,
      periodStart: record.periodStart.toISOString(),
      periodEnd: record.periodEnd.toISOString(),
      hours: record.hours?.toString() ?? null,
      kilometres: record.kilometres?.toString() ?? null,
      hourMeter: record.hourMeter?.toString() ?? null,
      odometer: record.odometer?.toString() ?? null,
      source: record.source,
      recordedAt: record.recordedAt.toISOString(),
      recordedBy: record.recordedBy,
    };
  }
}
