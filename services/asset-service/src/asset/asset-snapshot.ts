import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from './asset.repository';

/**
 * The asset as asset-service records it now, for the replicas that mirror it
 * (D-039).
 *
 * ## Why this exists
 *
 * `<topic>` and `<topic>.retry` are separate streams, so an event replayed on
 * `.retry` can arrive after newer ones. A replica that applied the replayed
 * payload would move backwards. Instead, on a `.retry` delivery, fleet-service
 * and maintenance-service do not apply the payload: they read the current
 * state here and write the replica from that. This service is the only
 * authority on it.
 *
 * ## The lock on the door
 *
 * The ADR-061 § 4 pattern, as for the transfer record: `/v1/internal/…`,
 * which the gateway routes nowhere; `@AllowService` on the route and
 * {@link assertSnapshotCaller} here, which also refuses every user token; the
 * organization is the one signed into the internal token (ADR-035), never a
 * header.
 *
 * ## What it answers, to whom
 *
 *   - the **current owner**: the full snapshot;
 *   - a **previous owner** recorded in `asset_transfer`: only that the asset
 *     was transferred, who owns it now and the transfer generation — nothing
 *     about the machine itself (it learned the new owner from
 *     `ASSET_TRANSFERRED` already);
 *   - **anyone else**, and an asset that does not exist: the same `404`, so no
 *     organization can probe another's assets.
 */

/** The only callers: the services that keep a replica of the asset. */
export const SNAPSHOT_CALLERS = ['fleet-service', 'maintenance-service'] as const;

export interface AssetSnapshotView {
  transferred: false;
  assetId: string;
  organizationId: string;
  status: string;
  name: string;
  type: string;
  assetTag: string | null;
  transferGeneration: number;
}

export interface TransferredAssetView {
  transferred: true;
  assetId: string;
  /** The current owner. */
  organizationId: string;
  transferGeneration: number;
}

export type AssetSnapshotResponse = AssetSnapshotView | TransferredAssetView;

export function assertSnapshotCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    !(SNAPSHOT_CALLERS as readonly string[]).includes(context.callerService ?? '')
  ) {
    throw RastaError.forbidden('This endpoint is reserved for the services that replicate assets');
  }
}

interface SnapshotRow {
  organization_id: string;
  status: string;
  name: string;
  type: string;
  asset_tag: string | null;
  ownership_generation: number;
}

@Injectable()
export class AssetSnapshotService {
  constructor(private readonly repository: AssetRepository) {}

  async snapshot(assetId: string): Promise<AssetSnapshotResponse> {
    assertSnapshotCaller();
    // A token with no organization is a 403 here, before any query.
    const organizationId = getOrganizationId();

    const row = await runUnscoped(
      'a replica reads the asset by id for the organization signed into its token (D-039)',
      async () => {
        const rows = await this.repository.client.$queryRaw<SnapshotRow[]>`
          SELECT organization_id, status::text AS status, name, type::text AS type,
                 asset_tag, ownership_generation
          FROM asset WHERE id = ${assetId} AND deleted_at IS NULL`;
        const found = rows[0];
        if (!found) return null;
        if (found.organization_id === organizationId) return { found, previous: false };
        const transfers = await this.repository.client.$queryRaw<{ id: string }[]>`
          SELECT id FROM asset_transfer
          WHERE asset_id = ${assetId} AND from_organization_id = ${organizationId}
          LIMIT 1`;
        return transfers.length > 0 ? { found, previous: true } : null;
      },
    );
    if (!row) throw RastaError.notFound('Asset', assetId);

    if (row.previous) {
      return {
        transferred: true,
        assetId,
        organizationId: row.found.organization_id,
        transferGeneration: row.found.ownership_generation,
      };
    }
    return {
      transferred: false,
      assetId,
      organizationId: row.found.organization_id,
      status: row.found.status,
      name: row.found.name,
      type: row.found.type,
      assetTag: row.found.asset_tag,
      transferGeneration: row.found.ownership_generation,
    };
  }
}
