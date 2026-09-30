import { z } from 'zod';
import { RastaError, internalGet, type InternalGetOptions } from '@rasta/nest-common';

/**
 * Where the asset replica is refreshed from when an event arrives on
 * `<topic>.retry` (D-039).
 *
 * `<topic>` and `<topic>.retry` are separate streams, so a replayed event can
 * be older than what was applied since. The replica does not apply its
 * payload; it reads the current state from asset-service, which owns it
 * (ADR-061 § 4), and is written from that. Any answer that is not a
 * well-formed `200` about this asset is no answer: the read throws, the event
 * is retried and then dead-lettered, and the stale payload is never applied.
 */

export const ASSET_SERVICE = 'asset-service';

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
   * change only.
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

/** What a service built without asset-service gets: a replay is refused, never guessed. */
export const UNCONFIGURED_ASSET_SNAPSHOT_SOURCE: AssetSnapshotSource = {
  snapshot: async () => {
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
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
