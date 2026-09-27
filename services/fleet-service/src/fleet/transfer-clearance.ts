import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { FleetRepository } from './fleet.repository';
import {
  TRANSFER_RECORD_SOURCE,
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  settleExpiredFence,
  type TransferRecordSource,
} from './transfer-record';

/**
 * Whether a machine can leave its owner, as fleet-service sees it (ADR-062).
 *
 * ## Why this exists
 *
 * asset-service refuses to transfer a machine with open work, but it learns
 * about an assignment only from `ASSET_ASSIGNED`, which it may not have
 * consumed yet (docs/23 D-033). So before it commits a transfer it asks here,
 * and this service's database is the only authority on the answer.
 *
 * ## The answer holds until the transfer commits
 *
 * Counting and fencing happen in one transaction, under `lockAssetRef` — the
 * lock every assignment takes before its insert. So either an assignment
 * committed first and is counted, or it comes after and meets the fence
 * (`AssignmentService.assertAssetAssignable`). The fence stays until the
 * asset-sync consumer moves the replica to the new owner, until asset-service
 * releases it, or until it expires.
 *
 * ## The lock on the door
 *
 * The same as ADR-061 § 4: `/v1/internal/…`, which the gateway routes nowhere;
 * `@AllowService` on the route and {@link assertClearanceCaller} here, which
 * also refuses every user token; the tenant is the one signed into the
 * internal token (ADR-035), never a header. The answer is a yes or no and a
 * count, for this machine and that organization only: no assignment, driver
 * or date. A machine the replica places in another organization is not found.
 */

/** The only caller. */
export const CLEARANCE_CALLER = 'asset-service';

/** Bounds on the fence's life, whatever the caller asks for. */
export const FENCE_TTL_MIN_SECONDS = 30;
export const FENCE_TTL_MAX_SECONDS = 3600;

export const assetIdParamSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** asset-service's transfer id. */
export const fenceIdSchema = z.string().regex(/^TRF_[0-9A-HJKMNP-TV-Z]{26}$/);

export const transferClearanceSchema = z
  .object({
    fenceId: fenceIdSchema,
    ttlSeconds: z.number().int().min(FENCE_TTL_MIN_SECONDS).max(FENCE_TTL_MAX_SECONDS),
  })
  .strict();

export type TransferClearanceDto = z.infer<typeof transferClearanceSchema>;

export interface TransferClearanceView {
  assetId: string;
  fenceId: string;
  /** `true` only when nothing is open and the fence is in place. */
  clear: boolean;
  /** The fence's expiry, by this service's database clock; `null` when not clear. */
  fencedUntil: string | null;
  openAssignments: number;
}

export function assertClearanceCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== CLEARANCE_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the asset transfer');
  }
}

@Injectable()
export class TransferClearanceService {
  constructor(
    private readonly repository: FleetRepository,
    @Optional()
    @Inject(TRANSFER_RECORD_SOURCE)
    private readonly records: TransferRecordSource = UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  ) {}

  async clear(assetId: string, dto: TransferClearanceDto): Promise<TransferClearanceView> {
    assertClearanceCaller();
    // A token with no organization is a 403 here, before any query.
    const organizationId = getOrganizationId();

    // Whose machine it is, before anything is asked about its fence (review
    // #127 round 2, #1). Absent is fine: no work can exist for a machine the
    // replica has never seen. Present elsewhere is either another tenant's
    // machine or a replica that has not caught up with a transfer; neither is
    // answered, and no fence on it is resolved.
    const asset = await this.repository.findAssetRef(assetId);
    if (asset && asset.organizationId !== organizationId) {
      throw RastaError.notFound('Asset', assetId);
    }

    // An expired fence of another transfer is resolved at its source before
    // this one may take its place (ADR-062 § 3b). One that landed means the
    // replica has not caught up with it yet, and one another organization
    // placed is not this caller's to resolve: a conflict either way.
    const settled = await settleExpiredFence(
      this.repository,
      this.records,
      assetId,
      organizationId,
    );
    if (settled === 'RECORDED' || settled === 'FOREIGN') {
      throw anotherTransfer();
    }

    return this.repository.transaction(async (tx) => {
      await this.repository.lockAssetRef(tx, assetId);

      // Released already: asset-service gave up on this transfer, and its
      // release reached the lock first (review #127 round 2, #2). No fence
      // for a transfer that no longer exists.
      if (await this.repository.isTransferReleased(tx, assetId, organizationId, dto.fenceId)) {
        throw RastaError.invalidStateTransition(
          'Asset',
          'TRANSFER_PENDING',
          'TRANSFER_PENDING',
          'This transfer was withdrawn',
        );
      }

      // Absent is fine: no assignment can exist for a machine the replica has
      // never seen, and the fence below still stops the first one. Present in
      // another organization is either another tenant's machine or a replica
      // that has not caught up with a transfer; neither is answered.
      const asset = await this.repository.findAssetRef(assetId, tx);
      if (asset && asset.organizationId !== organizationId) {
        throw RastaError.notFound('Asset', assetId);
      }

      const openAssignments = await this.repository.countActiveAssignmentsForAsset(tx, assetId);
      if (openAssignments > 0) {
        return { assetId, fenceId: dto.fenceId, clear: false, fencedUntil: null, openAssignments };
      }

      const fencedUntil = await this.repository.placeTransferFence(
        tx,
        assetId,
        organizationId,
        dto.fenceId,
        dto.ttlSeconds,
      );
      if (!fencedUntil) {
        // Another transfer's fence stands. Taking it over would let that
        // transfer's release lift this one's, and an expired one is only
        // lifted by its source's answer, above.
        throw anotherTransfer();
      }

      return {
        assetId,
        fenceId: dto.fenceId,
        clear: true,
        fencedUntil: fencedUntil.toISOString(),
        openAssignments: 0,
      };
    });
  }

  /** Lifts a fence for a transfer that did not happen. Idempotent; under the asset lock. */
  async release(assetId: string, fenceId: string): Promise<void> {
    assertClearanceCaller();
    const organizationId = getOrganizationId();
    await this.repository.releaseTransferFence(
      assetId,
      organizationId,
      fenceId,
      FENCE_TTL_MAX_SECONDS,
    );
  }
}

function anotherTransfer(): RastaError {
  return RastaError.invalidStateTransition(
    'Asset',
    'TRANSFER_PENDING',
    'TRANSFER_PENDING',
    'Another transfer of this asset is in progress',
  );
}
