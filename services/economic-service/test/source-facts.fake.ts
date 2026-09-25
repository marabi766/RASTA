import { RastaError } from '@rasta/nest-common';
import type {
  MaintenanceRequestFact,
  SourceFacts,
  UsageRecordFact,
} from '../src/provenance/source-facts.client';

/**
 * maintenance-service and fleet-service, as far as the consumers can tell.
 *
 * A registry of what each owner "recorded". A lookup answers exactly as the
 * real internal reads do: the record, or `null` when it does not exist **in the
 * organization the token was signed for**. That scoping is the owner's, and
 * the tests about forged organizations depend on it being modelled rather than
 * skipped. `unavailable` makes every call fail the way a down owner does.
 *
 * The HTTP half (tokens, status codes, parsing) is proved separately against
 * a fake `fetch` in `source-facts.client.spec.ts`.
 */
export class FakeSourceFacts implements SourceFacts {
  readonly requests = new Map<string, MaintenanceRequestFact>();
  readonly usage = new Map<string, UsageRecordFact>();
  readonly calls: { owner: 'maintenance' | 'fleet'; organizationId: string; id: string }[] = [];
  unavailable = false;

  async maintenanceRequest(
    organizationId: string,
    id: string,
  ): Promise<MaintenanceRequestFact | null> {
    this.calls.push({ owner: 'maintenance', organizationId, id });
    if (this.unavailable) throw RastaError.upstreamUnavailable('maintenance-service');
    const fact = this.requests.get(id);
    return fact && fact.organizationId === organizationId ? fact : null;
  }

  async usageRecord(organizationId: string, id: string): Promise<UsageRecordFact | null> {
    this.calls.push({ owner: 'fleet', organizationId, id });
    if (this.unavailable) throw RastaError.upstreamUnavailable('fleet-service');
    const fact = this.usage.get(id);
    return fact && fact.organizationId === organizationId ? fact : null;
  }

  /** The approval an honest `MAINTENANCE_APPROVED` announces, recorded by its owner. */
  approved(
    payload: {
      requestId: string;
      organizationId: string;
      assetId: string;
      approvedBy: string;
      approvedAt: string;
      workshopOrganizationId?: string | null;
      totalCostMinor: string;
      currency: string;
    },
    overrides: Partial<MaintenanceRequestFact> = {},
  ): MaintenanceRequestFact {
    const fact: MaintenanceRequestFact = {
      id: payload.requestId,
      organizationId: payload.organizationId,
      assetId: payload.assetId,
      type: 'CORRECTIVE',
      scheduleId: null,
      status: 'APPROVED',
      completedAt: payload.approvedAt,
      completedBy: 'USR-FAKE-COMPLETER',
      downtimeMinutes: null,
      approvedAt: payload.approvedAt,
      approvedBy: payload.approvedBy,
      totalCostMinor: payload.totalCostMinor,
      currency: payload.currency,
      workshopOrganizationId: payload.workshopOrganizationId ?? null,
      ...overrides,
    };
    this.requests.set(fact.id, fact);
    return fact;
  }

  /** A completed repair, as maintenance-service records it. */
  completed(
    payload: { requestId: string; organizationId: string; assetId: string },
    overrides: Partial<MaintenanceRequestFact> = {},
  ): MaintenanceRequestFact {
    const fact: MaintenanceRequestFact = {
      id: payload.requestId,
      organizationId: payload.organizationId,
      assetId: payload.assetId,
      type: 'PREVENTIVE',
      scheduleId: null,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      completedBy: 'USR-FAKE-COMPLETER',
      downtimeMinutes: 90,
      approvedAt: null,
      approvedBy: null,
      totalCostMinor: '0',
      currency: 'IRR',
      workshopOrganizationId: null,
      ...overrides,
    };
    this.requests.set(fact.id, fact);
    return fact;
  }

  /** A usage record, as fleet-service records it. */
  recorded(
    payload: { usageRecordId: string; organizationId: string; assetId: string; hours?: string },
    overrides: Partial<UsageRecordFact> = {},
  ): UsageRecordFact {
    const now = new Date();
    const fact: UsageRecordFact = {
      id: payload.usageRecordId,
      organizationId: payload.organizationId,
      assetId: payload.assetId,
      driverId: null,
      assignmentId: null,
      periodStart: new Date(now.getTime() - 8 * 3_600_000).toISOString(),
      periodEnd: now.toISOString(),
      hours: payload.hours ?? '7.5',
      kilometres: null,
      hourMeter: null,
      odometer: null,
      source: 'MANUAL',
      recordedAt: now.toISOString(),
      recordedBy: 'USR-FAKE-RECORDER',
      ...overrides,
    };
    this.usage.set(fact.id, fact);
    return fact;
  }
}
