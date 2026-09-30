import { z } from 'zod';
import { RastaError, internalGet, type InternalGetOptions } from '@rasta/nest-common';
import type { AssetStatus } from '../asset/lifecycle';

/**
 * What the owners of a machine's work say about it now, read when an
 * `ASSIGNED`/`IN_MAINTENANCE`-driving event is replayed on `.retry` (D-039).
 *
 * asset-service's status follows fleet-service (an active assignment) and
 * maintenance-service (a repair in progress); it learns it from their events.
 * A replayed event may be older than what was applied since, so on a replay
 * the payload is not applied: the status is derived from what the two owners
 * say now, and only ever applied through the transition table. Both answers
 * are required — one missing is a thrown error, never a guess.
 */
export interface AssetWorkState {
  readonly activeAssignment: boolean;
  readonly inMaintenance: boolean;
}

export interface AssetWorkStateSource {
  /** Both owners' current answer, for the organization that owns the asset. Throws when either gives none. */
  read(organizationId: string, assetId: string): Promise<AssetWorkState>;
}

/** What a service built without its peers gets: a replay is refused, never guessed. */
export const UNCONFIGURED_WORK_STATE_SOURCE: AssetWorkStateSource = {
  read: async () => {
    throw RastaError.upstreamUnavailable('fleet-service');
  },
};

/** The status the two owners' answers imply; the transition table still decides whether it may be applied. */
export function statusFromWorkState(state: AssetWorkState): AssetStatus {
  if (state.inMaintenance) return 'IN_MAINTENANCE';
  if (state.activeAssignment) return 'ASSIGNED';
  return 'ACTIVE';
}

const assignmentSchema = z.object({ assetId: z.string(), activeAssignment: z.boolean() });
const maintenanceSchema = z.object({ assetId: z.string(), inMaintenance: z.boolean() });

export interface AssetWorkStateClientOptions {
  readonly fleet: Omit<InternalGetOptions, 'from' | 'to'>;
  readonly maintenance: Omit<InternalGetOptions, 'from' | 'to'>;
  readonly from: string;
}

/**
 * fleet-service's `…/assignment-state` and maintenance-service's
 * `…/maintenance-state`, each under a fresh `SERVICE` token signed with the
 * asset's owner. Only a well-formed `200` about this asset is an answer;
 * transport, timeout, `403`, `404`, `5xx` or another body is none.
 */
export class AssetWorkStateClient implements AssetWorkStateSource {
  constructor(private readonly options: AssetWorkStateClientOptions) {}

  async read(organizationId: string, assetId: string): Promise<AssetWorkState> {
    const id = encodeURIComponent(assetId);
    const [assignment, maintenance] = await Promise.all([
      internalGet(
        { ...this.options.fleet, from: this.options.from, to: 'fleet-service' },
        `/v1/internal/assets/${id}/assignment-state`,
        organizationId,
      ),
      internalGet(
        { ...this.options.maintenance, from: this.options.from, to: 'maintenance-service' },
        `/v1/internal/assets/${id}/maintenance-state`,
        organizationId,
      ),
    ]);

    const a = assignment.status === 200 ? assignmentSchema.safeParse(assignment.body) : null;
    if (!a?.success || a.data.assetId !== assetId) {
      throw RastaError.upstreamUnavailable('fleet-service');
    }
    const m = maintenance.status === 200 ? maintenanceSchema.safeParse(maintenance.body) : null;
    if (!m?.success || m.data.assetId !== assetId) {
      throw RastaError.upstreamUnavailable('maintenance-service');
    }
    return { activeAssignment: a.data.activeAssignment, inMaintenance: m.data.inMaintenance };
  }
}
