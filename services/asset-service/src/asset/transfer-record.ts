import { Controller, Get, Injectable, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  AllowService,
  RastaError,
  getContext,
  getOrganizationId,
  zodPipe,
} from '@rasta/nest-common';
import { AssetRepository } from './asset.repository';
import {
  AssetSnapshotService,
  SNAPSHOT_CALLERS,
  type AssetSnapshotResponse,
} from './asset-snapshot';

/**
 * Whether a transfer was recorded, for the owners of a machine's work who hold
 * its expired fence (ADR-062 § 3b).
 *
 * ## Why this exists
 *
 * fleet-service and maintenance-service fence a machine while a transfer
 * commits. A fence that expires before they have consumed
 * `ASSET_TRANSFERRED` cannot tell them whether the transfer landed — their
 * replica may still name the previous owner either way. Expiry alone must not
 * reopen the machine, so they ask here, the one service whose database knows.
 *
 * ## The lock on the door
 *
 * The ADR-061 § 4 pattern: `/v1/internal/…`, which the gateway routes
 * nowhere; `@AllowService` on the route and {@link assertTransferRecordCaller}
 * here, which also refuses every user token; the organization is the one
 * signed into the internal token (ADR-035), never a header.
 *
 * ## What it answers
 *
 * One fact about one transfer the calling organization made: `200` with
 * `recorded: true` when transfer `transferId` moved `assetId` away from that
 * organization, and the platform's `404 AssetTransfer not found` otherwise —
 * whether the transfer never committed, never existed, or belongs to someone
 * else. Those three are deliberately indistinguishable, so no organization can
 * probe another's transfers.
 */

/** The only callers: the services that fence a machine for a transfer. */
export const TRANSFER_RECORD_CALLERS = ['fleet-service', 'maintenance-service'] as const;

export const assetIdParamSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const transferIdParamSchema = z.string().regex(/^TRF_[0-9A-HJKMNP-TV-Z]{26}$/);

export interface TransferRecordView {
  assetId: string;
  transferId: string;
  recorded: true;
}

export function assertTransferRecordCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    !(TRANSFER_RECORD_CALLERS as readonly string[]).includes(context.callerService ?? '')
  ) {
    throw RastaError.forbidden('This endpoint is reserved for the owners of a transfer fence');
  }
}

@Injectable()
export class TransferRecordService {
  constructor(private readonly repository: AssetRepository) {}

  async recorded(assetId: string, transferId: string): Promise<TransferRecordView> {
    assertTransferRecordCaller();
    // A token with no organization is a 403 here, before any query.
    const organizationId = getOrganizationId();

    if (!(await this.repository.transferRecordedFrom(assetId, transferId, organizationId))) {
      throw RastaError.notFound('AssetTransfer', transferId);
    }
    return { assetId, transferId, recorded: true };
  }
}

/** HTTP to DTO only. */
@ApiTags('asset-internal')
@Controller({ path: 'internal/assets', version: '1' })
export class AssetInternalController {
  constructor(
    private readonly records: TransferRecordService,
    private readonly snapshots: AssetSnapshotService,
  ) {}

  @Get(':assetId/snapshot')
  @AllowService(...SNAPSHOT_CALLERS)
  @ApiParam({ name: 'assetId', schema: { type: 'string', maxLength: 64 } })
  @ApiOperation({
    summary: 'The asset as asset-service records it now, for a replica (internal)',
    description:
      'Reserved for fleet-service and maintenance-service service tokens; every other service ' +
      'and every user token is refused. The organization is the one signed into the token. ' +
      'The current owner gets the owner, status, name, type and tag; a previous owner recorded ' +
      'in the asset’s transfers gets only `transferred: true`, the current owner and the ' +
      'transfer generation; any other organization gets the `404` of an asset that does not exist.',
  })
  snapshot(
    @Param('assetId', zodPipe(assetIdParamSchema)) assetId: string,
  ): Promise<AssetSnapshotResponse> {
    return this.snapshots.snapshot(assetId);
  }

  @Get(':assetId/transfers/:transferId')
  @AllowService(...TRANSFER_RECORD_CALLERS)
  @ApiParam({ name: 'assetId', schema: { type: 'string', maxLength: 64 } })
  @ApiParam({ name: 'transferId', schema: { type: 'string', pattern: '^TRF_[0-9A-Z]{26}$' } })
  @ApiOperation({
    summary: 'Whether a transfer by the calling organization was recorded (internal)',
    description:
      'Reserved for fleet-service and maintenance-service service tokens; every other service ' +
      'and every user token is refused. The organization is the one signed into the token. ' +
      '`200` when the transfer moved the asset away from that organization; `404` otherwise, ' +
      'including for another organization’s transfer. Waits for a transfer still committing.',
  })
  recorded(
    @Param('assetId', zodPipe(assetIdParamSchema)) assetId: string,
    @Param('transferId', zodPipe(transferIdParamSchema)) transferId: string,
  ): Promise<TransferRecordView> {
    return this.records.recorded(assetId, transferId);
  }
}
