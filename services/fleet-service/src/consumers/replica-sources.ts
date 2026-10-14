import { z } from 'zod';
import { RastaError, internalGet, type InternalGetOptions } from '@rasta/nest-common';

/**
 * Where the asset replica is refreshed from when an event arrives on
 * `<topic>.retry` (D-039).
 *
 * `<topic>` and `<topic>.retry` are separate streams, so a replayed event can
 * be older than what was applied since. The replica does not apply its
 * payload; it reads the current state from the service that owns it (ADR-061
 * § 4) and is written from that. Any answer that is not a well-formed `200`
 * about this asset is no answer: the read throws, the event is retried and
 * then dead-lettered, and the stale payload is never applied.
 */

export const ASSET_SERVICE = 'asset-service';
export const MAINTENANCE_SERVICE = 'maintenance-service';

/** The asset as asset-service records it, for the organization that owns it. */
export interface AssetSnapshot {
  readonly assetId: string;
  readonly organizationId: string;
  readonly status: string;
  readonly name: string;
  readonly type: string;
  readonly assetTag: string | null;
  readonly transferGeneration: number;
  /**
   * The organization asked no longer owns the machine: asset-service answered
   * it with the recorded transfer, and this is the current owner's snapshot,
   * fetched by following that transfer. Such an event is good for the owner
   * change only — nothing it says may take effect for a tenant that no longer
   * owns the machine.
   */
  readonly viaTransfer: boolean;
}

export interface AssetSnapshotSource {
  /**
   * The current snapshot. `organizationId` is the caller's best knowledge of
   * the owner (the replica's, else the event's tenant); a machine that has
   * since been transferred is followed to its current owner once. `null` when
   * asset-service does not know the asset for that organization. Throws when
   * there is no answer.
   */
  snapshot(organizationId: string, assetId: string): Promise<AssetSnapshot | null>;
}

export interface MaintenanceStateSource {
  /** Whether a repair is in progress on the machine. Throws when there is no answer. */
  inMaintenance(organizationId: string, assetId: string): Promise<boolean>;
}

/** What a service built without its peers gets: a replay is refused, never guessed. */
export const UNCONFIGURED_ASSET_SNAPSHOT_SOURCE: AssetSnapshotSource = {
  snapshot: async () => {
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  },
};
export const UNCONFIGURED_MAINTENANCE_STATE_SOURCE: MaintenanceStateSource = {
  inMaintenance: async () => {
    throw RastaError.upstreamUnavailable(MAINTENANCE_SERVICE);
  },
};

const fullSchema = z.object({
  transferred: z.literal(false),
  assetId: z.string(),
  organizationId: z.string().min(1),
  status: z.string().min(1),
  name: z.string(),
  type: z.string(),
  assetTag: z.string().nullable(),
  transferGeneration: z.number().int(),
});
const transferredSchema = z.object({
  transferred: z.literal(true),
  assetId: z.string(),
  organizationId: z.string().min(1),
  transferGeneration: z.number().int(),
});
const maintenanceSchema = z.object({ assetId: z.string(), inMaintenance: z.boolean() });
const platformErrorSchema = z.object({ code: z.string() });

type Options = Omit<InternalGetOptions, 'from' | 'to'> & { readonly from: string };

/** asset-service's `GET /v1/internal/assets/{assetId}/snapshot`. */
export class AssetSnapshotClient implements AssetSnapshotSource {
  constructor(private readonly options: Options) {}

  async snapshot(organizationId: string, assetId: string): Promise<AssetSnapshot | null> {
    // At most one hop: the previous owner is told who owns the machine now,
    // and that owner is asked. A second `transferred` is no answer.
    const first = await this.ask(organizationId, assetId);
    if (first === null) return null;
    if (!first.transferred) return { ...first, viaTransfer: false };
    const second = await this.ask(first.organizationId, assetId);
    if (second === null) return null;
    if (second.transferred) throw RastaError.upstreamUnavailable(ASSET_SERVICE);
    return { ...second, viaTransfer: true };
  }

  private async ask(
    organizationId: string,
    assetId: string,
  ): Promise<z.infer<typeof fullSchema> | z.infer<typeof transferredSchema> | null> {
    const { status, body } = await internalGet(
      { ...this.options, to: ASSET_SERVICE },
      `/v1/internal/assets/${encodeURIComponent(assetId)}/snapshot`,
      organizationId,
    );
    if (status === 200) {
      const full = fullSchema.safeParse(body);
      if (full.success && full.data.assetId === assetId) return full.data;
      const moved = transferredSchema.safeParse(body);
      if (moved.success && moved.data.assetId === assetId) return moved.data;
    } else if (status === 404) {
      const parsed = platformErrorSchema.safeParse(body);
      if (parsed.success && parsed.data.code === 'NOT_FOUND') return null;
    }
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  }
}

/**
 * What asset-service says about one recorded policy, now (ADR-061 § 4, #240 r6).
 *
 * `counts: true` is the only answer fleet stores anything from: the window and
 * the ownership generation are the source's, not the event's, so an event that
 * is replayed, late, or from a previous tenure cannot carry a stale one in.
 */
export type PolicyVerdict =
  | {
      readonly counts: true;
      /** The asset's current owner. */
      readonly organizationId: string;
      readonly coverage: string;
      readonly validFrom: string;
      readonly validUntil: string;
      /** The asset's current ownership generation. */
      readonly ownershipGeneration: number;
    }
  | { readonly counts: false; readonly reason: string };

export interface InsurancePolicySource {
  /**
   * Whether the policy counts for the asset's current owner under asset-service's
   * current following rule. `organizationId` is the owner the caller's replica
   * shows (else the event's tenant): asset-service answers the CURRENT owner
   * only, and any other tenant gets `counts: false` with `NOT_CURRENT_OWNER`
   * and no owner — it is not followed. An unknown policy is `counts: false`.
   * Throws when there is no answer.
   */
  verify(organizationId: string, assetId: string, policyId: string): Promise<PolicyVerdict>;
}

/** What a service built without asset-service gets: no policy is applied unverified. */
export const UNCONFIGURED_INSURANCE_POLICY_SOURCE: InsurancePolicySource = {
  verify: async () => {
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  },
};

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const countingSchema = z.object({
  transferred: z.literal(false),
  assetId: z.string(),
  policyId: z.string(),
  organizationId: z.string().min(1),
  counts: z.literal(true),
  coverage: z.string().min(1),
  validFrom: instant,
  validUntil: instant,
  ownershipGeneration: z.number().int().nonnegative(),
});
const notCountingSchema = z.object({
  transferred: z.literal(false),
  assetId: z.string(),
  policyId: z.string(),
  counts: z.literal(false),
  reason: z.string().min(1),
});

/** asset-service's `GET /v1/internal/assets/{assetId}/insurance-policies/{policyId}`. */
export class InsurancePolicyClient implements InsurancePolicySource {
  constructor(private readonly options: Options) {}

  async verify(organizationId: string, assetId: string, policyId: string): Promise<PolicyVerdict> {
    const { status, body } = await internalGet(
      { ...this.options, to: ASSET_SERVICE },
      `/v1/internal/assets/${encodeURIComponent(assetId)}/insurance-policies/${encodeURIComponent(policyId)}`,
      organizationId,
    );
    if (status === 200) {
      const counting = countingSchema.safeParse(body);
      if (
        counting.success &&
        counting.data.assetId === assetId &&
        counting.data.policyId === policyId
      ) {
        const {
          transferred: _transferred,
          assetId: _asset,
          policyId: _policy,
          ...verdict
        } = counting.data;
        return verdict;
      }
      const not = notCountingSchema.safeParse(body);
      if (not.success && not.data.assetId === assetId && not.data.policyId === policyId) {
        return { counts: false, reason: not.data.reason };
      }
    } else if (status === 404) {
      const parsed = platformErrorSchema.safeParse(body);
      if (parsed.success && parsed.data.code === 'NOT_FOUND') {
        return { counts: false, reason: 'UNKNOWN_POLICY' };
      }
    }
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  }
}

/** maintenance-service's `GET /v1/internal/assets/{assetId}/maintenance-state`. */
export class MaintenanceStateClient implements MaintenanceStateSource {
  constructor(private readonly options: Options) {}

  async inMaintenance(organizationId: string, assetId: string): Promise<boolean> {
    const { status, body } = await internalGet(
      { ...this.options, to: MAINTENANCE_SERVICE },
      `/v1/internal/assets/${encodeURIComponent(assetId)}/maintenance-state`,
      organizationId,
    );
    if (status === 200) {
      const parsed = maintenanceSchema.safeParse(body);
      if (parsed.success && parsed.data.assetId === assetId) return parsed.data.inMaintenance;
    }
    throw RastaError.upstreamUnavailable(MAINTENANCE_SERVICE);
  }
}
