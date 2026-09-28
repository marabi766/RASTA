import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Logger, Optional, type NestMiddleware } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { MaintenanceRepository } from './maintenance.repository';
import {
  TRANSFER_RECORD_SOURCE,
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  settleExpiredFence,
  type TransferRecordSource,
} from './transfer-record';

/**
 * Whether a machine can leave its owner, as maintenance-service sees it
 * (ADR-062).
 *
 * ## Why this exists
 *
 * asset-service refuses to transfer a machine with open work, but it learns
 * about a repair only from `MAINTENANCE_STARTED`, which it may not have
 * consumed yet, and about a reported breakdown not at all (docs/23 D-033). So
 * before it commits a transfer it asks here, and this service's database is
 * the only authority on the answer.
 *
 * "Open" is a request that is `OPEN` or `IN_PROGRESS`, or a repair order that
 * is `OPEN` or `IN_PROGRESS`. A `COMPLETED` request awaiting the owner's
 * approval is not: the work is done, and approving its cost is the financial
 * act of the organization that ordered it.
 *
 * ## The answer holds until the transfer commits
 *
 * Counting and fencing happen in one transaction, under the exclusive
 * `asset-work` lock. A new request takes the same lock (shared) before its
 * insert, so either it committed first and is counted, or it comes after and
 * meets the fence (`RequestService.create`). A repair order needs an open
 * request, so it cannot appear under a fence either. The fence stays until
 * the asset-sync consumer moves the replica to the new owner, until
 * asset-service releases it, or until it expires.
 *
 * ## The lock on the door
 *
 * The same as ADR-061 § 4: `/v1/internal/…`, which the gateway routes nowhere;
 * `@AllowService` on the route and {@link assertClearanceCaller} here, which
 * also refuses every user token; the tenant is the one signed into the
 * internal token (ADR-035), never a header. The answer is a yes or no and
 * counts, for this machine and that organization only: no request, title,
 * workshop or date. A machine the replica places in another organization is not found.
 */

/** The only caller. */
export const CLEARANCE_CALLER = 'asset-service';

/**
 * The longest a clearance may take, from its arrival to the fence (review #127
 * round 3, #2). A request that has been held longer — waiting for a
 * connection, or resolving an older fence at its source — places no fence:
 * asset-service has long given up on it and may already have released it.
 * Measured on this service's monotonic clock only. Far below the release
 * tombstone's life (FENCE_TTL_MAX_SECONDS, an hour), so a clearance can never
 * outlive the tombstone that withdraws it (ADR-062 § 2).
 */
export const CLEARANCE_HANDLER_MAX_MS = 60_000;

/** The monotonic clock the bound is measured on; replaced in tests. */
export const CLEARANCE_CLOCK = Symbol('TRANSFER_CLEARANCE_CLOCK');

/** Where the arrival stamp is kept on the request; a symbol, so no header or body can set it. */
const CLEARANCE_ARRIVAL = Symbol('TRANSFER_CLEARANCE_ARRIVAL');

/**
 * Stamps a clearance request's arrival on this service's monotonic clock, as
 * the first thing the process does with it (review #127 round 4, #1).
 *
 * Nest runs middleware before guards and pipes, so the bound
 * ({@link CLEARANCE_HANDLER_MAX_MS}) is measured from here, not from the
 * handler: a request held in the internal-token verification or anywhere else
 * on the way to `clear()` has already spent that time. What remains unbounded
 * is a process frozen before its own middleware runs (ADR-062 § 2).
 */
@Injectable()
export class ClearanceArrivalMiddleware implements NestMiddleware {
  constructor(
    @Optional()
    @Inject(CLEARANCE_CLOCK)
    private readonly clock: () => number = () => performance.now(),
  ) {}

  use(request: object, _response: unknown, next: () => void): void {
    (request as Record<symbol, number>)[CLEARANCE_ARRIVAL] = this.clock();
    next();
  }
}

/** The arrival {@link ClearanceArrivalMiddleware} stamped, if it ran for this request. */
export function clearanceArrival(request: object): number | undefined {
  const stamp = (request as Record<symbol, unknown>)[CLEARANCE_ARRIVAL];
  return typeof stamp === 'number' ? stamp : undefined;
}

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
  openRequests: number;
  openRepairOrders: number;
}

export function assertClearanceCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== CLEARANCE_CALLER) {
    throw RastaError.forbidden('This endpoint is reserved for the asset transfer');
  }
}

@Injectable()
export class TransferClearanceService {
  private readonly logger = new Logger(TransferClearanceService.name);

  constructor(
    private readonly repository: MaintenanceRepository,
    @Optional()
    @Inject(TRANSFER_RECORD_SOURCE)
    private readonly records: TransferRecordSource = UNCONFIGURED_TRANSFER_RECORD_SOURCE,
    @Optional()
    @Inject(CLEARANCE_CLOCK)
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /**
   * `arrivedAt` is the request's arrival on {@link CLEARANCE_CLOCK}, stamped by
   * {@link ClearanceArrivalMiddleware} before any guard; the bound is measured
   * from it. Without one (a direct call), from now.
   */
  async clear(
    assetId: string,
    dto: TransferClearanceDto,
    arrivedAt: number = this.clock(),
  ): Promise<TransferClearanceView> {
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

    try {
      return await this.fence(assetId, dto, organizationId, arrivedAt);
    } finally {
      await this.purgeExpiredReleases();
    }
  }

  private fence(
    assetId: string,
    dto: TransferClearanceDto,
    organizationId: string,
    arrivedAt: number,
  ): Promise<TransferClearanceView> {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockAssetForWork(tx, assetId, 'EXCLUSIVE');

      // Released already: asset-service gave up on this transfer, and its
      // release reached the lock first (review #127 round 2, #2). No fence
      // for a transfer that no longer exists.
      if (await this.repository.isTransferReleased(tx, assetId, organizationId, dto.fenceId)) {
        throw withdrawn();
      }

      // Absent is fine: no request can exist for a machine the replica has
      // never seen, and the fence below still stops the first one. Present in
      // another organization is either another tenant's machine or a replica
      // that has not caught up with a transfer; neither is answered.
      const asset = await this.repository.findAssetRef(assetId, tx);
      if (asset && asset.organizationId !== organizationId) {
        throw RastaError.notFound('Asset', assetId);
      }

      const open = await this.repository.countOpenWork(tx, assetId, organizationId);
      if (open.openRequests > 0 || open.openRepairOrders > 0) {
        return { assetId, fenceId: dto.fenceId, clear: false, fencedUntil: null, ...open };
      }

      // Too old to fence (review #127 round 3, #2): a release, and even its
      // expired tombstone, may already be gone. Under the lock, just before
      // the fence, so nothing after this check can delay it.
      if (this.clock() - arrivedAt > CLEARANCE_HANDLER_MAX_MS) throw withdrawn();

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
        openRequests: 0,
        openRepairOrders: 0,
      };
    });
  }

  /** Lifts a fence for a transfer that did not happen. Idempotent; under the exclusive lock. */
  async release(assetId: string, fenceId: string): Promise<void> {
    assertClearanceCaller();
    const organizationId = getOrganizationId();
    await this.repository.releaseTransferFence(
      assetId,
      organizationId,
      fenceId,
      FENCE_TTL_MAX_SECONDS,
    );
    await this.purgeExpiredReleases();
  }

  /**
   * Expired tombstones, removed after the request's own transaction has
   * committed (review #127 round 4, #2). Best effort: a failure is logged and
   * never fails the clearance or release that triggered it; the next one
   * tries again.
   */
  private async purgeExpiredReleases(): Promise<void> {
    try {
      await this.repository.purgeExpiredReleases();
    } catch (error) {
      this.logger.warn(
        `Expired transfer-release tombstones not purged: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

function withdrawn(): RastaError {
  return RastaError.invalidStateTransition(
    'Asset',
    'TRANSFER_PENDING',
    'TRANSFER_PENDING',
    'This transfer was withdrawn',
  );
}
