import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';
import { transferFenceResolutionsTotal } from '../observability/metrics';

/**
 * Resolving an expired transfer fence at its source (ADR-062 § 3b, review
 * #127 #2).
 *
 * A fence stands on a machine while a transfer commits. If it expires before
 * this service has consumed `ASSET_TRANSFERRED`, the replica may still name
 * the previous owner whether or not the transfer landed, so expiry alone must
 * not reopen the machine. An assignment or a new clearance that meets an
 * expired fence asks asset-service whether that transfer was recorded:
 *
 *   - RECORDED: the machine left its owner; the fence stays until the
 *     consumer drops it on `ASSET_TRANSFERRED`, and the work is refused.
 *   - NOT_RECORDED: the transfer can never commit now, so the fence is
 *     deleted under the per-asset lock and the caller goes on.
 *   - no authenticated answer: refused, retryably. Only a machine with an
 *     expired, unresolved fence depends on asset-service being up.
 */

export const ASSET_SERVICE = 'asset-service';

export type TransferRecord = 'RECORDED' | 'NOT_RECORDED';

export interface TransferRecordSource {
  /** Whether `fenceId` moved `assetId` away from `organizationId`. Throws when there is no answer. */
  resolve(organizationId: string, assetId: string, fenceId: string): Promise<TransferRecord>;
}

export const TRANSFER_RECORD_SOURCE = Symbol('TRANSFER_RECORD_SOURCE');

/** What a service built without asset-service gets: no expired fence is ever lifted. */
export const UNCONFIGURED_TRANSFER_RECORD_SOURCE: TransferRecordSource = {
  resolve: async () => {
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  },
};

const recordedSchema = z.object({
  assetId: z.string(),
  transferId: z.string(),
  recorded: z.literal(true),
});
const platformErrorSchema = z.object({ code: z.string(), message: z.string() });

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface TransferRecordClientOptions {
  readonly baseUrl: string;
  /** `ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

/**
 * asset-service's `GET /v1/internal/assets/{assetId}/transfers/{transferId}`,
 * under a fresh `SERVICE` token signed with the organization that placed the
 * fence. Only a well-formed `recorded: true` about this transfer is RECORDED,
 * and only asset-service's own `404 AssetTransfer not found` is NOT_RECORDED;
 * anything else — transport, timeout, `403`, `5xx`, another body, a route or
 * proxy `404` — is no answer. Nothing from a failure goes into the error.
 */
export class TransferRecordClient implements TransferRecordSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TransferRecordClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async resolve(organizationId: string, assetId: string, fenceId: string): Promise<TransferRecord> {
    const token = await this.options.tokens.issue(
      SERVICE_NAME,
      ASSET_SERVICE,
      'SERVICE',
      organizationId,
    );
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': token,
    };
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/+$/, '')}/v1/internal/assets/` +
          `${encodeURIComponent(assetId)}/transfers/${encodeURIComponent(fenceId)}`,
        { method: 'GET', headers, signal: controller.signal },
      );
      text = await response.text();
      if (controller.signal.aborted) throw new Error('deadline passed');
      status = response.status;
    } catch {
      // No cause attached: a runtime's transport error can quote the URL.
      throw controller.signal.aborted
        ? RastaError.upstreamTimeout(ASSET_SERVICE, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(ASSET_SERVICE);
    } finally {
      clearTimeout(timer);
    }

    const body = parseJson(text);
    if (status === 200) {
      const parsed = recordedSchema.safeParse(body);
      if (parsed.success && parsed.data.assetId === assetId && parsed.data.transferId === fenceId) {
        return 'RECORDED';
      }
    } else if (status === 404) {
      const parsed = platformErrorSchema.safeParse(body);
      if (
        parsed.success &&
        parsed.data.code === 'NOT_FOUND' &&
        parsed.data.message === 'AssetTransfer not found'
      ) {
        return 'NOT_RECORDED';
      }
    }
    throw RastaError.upstreamUnavailable(ASSET_SERVICE);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The fence operations {@link settleExpiredFence} needs from the repository. */
export interface FenceStore {
  findTransferFence(
    assetId: string,
  ): Promise<{ fenceId: string; organizationId: string; expired: boolean } | null>;
  clearExpiredFence(assetId: string, fenceId: string): Promise<void>;
}

/**
 * Resolves an expired fence on `assetId`, if there is one, before a caller
 * takes the per-asset lock.
 *
 * `NONE` or `LIVE`: nothing to resolve (the caller's check under the lock
 * refuses a live fence). `CLEARED`: the transfer was not recorded and the
 * fence is gone. `RECORDED`: the transfer landed; the caller refuses. Throws
 * when asset-service gives no answer.
 *
 * Outside the lock on purpose: an expired fence's answer never changes —
 * RECORDED stays recorded, and a transfer that was not recorded can no longer
 * commit — so asking first and deleting that same fence under the lock after
 * is sound, and no connection is held open across an HTTP call.
 */
export async function settleExpiredFence(
  store: FenceStore,
  source: TransferRecordSource,
  assetId: string,
): Promise<'NONE' | 'LIVE' | 'CLEARED' | 'RECORDED'> {
  const fence = await store.findTransferFence(assetId);
  if (!fence) return 'NONE';
  if (!fence.expired) return 'LIVE';

  let answer: TransferRecord;
  try {
    answer = await source.resolve(fence.organizationId, assetId, fence.fenceId);
  } catch (error) {
    transferFenceResolutionsTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
    throw error;
  }

  if (answer === 'RECORDED') {
    transferFenceResolutionsTotal.inc({ service: SERVICE_NAME, outcome: 'recorded' });
    return 'RECORDED';
  }
  await store.clearExpiredFence(assetId, fence.fenceId);
  transferFenceResolutionsTotal.inc({ service: SERVICE_NAME, outcome: 'not_recorded' });
  return 'CLEARED';
}

/** The refusal for an assignment on a machine whose transfer has landed. */
export function ownerChanged(assetId: string): RastaError {
  return RastaError.businessRule(
    'The machine has been transferred to another organization and cannot be assigned.',
    { rule: 'ASSET_OWNER_CHANGED', assetId, owner: ASSET_SERVICE },
  );
}

/** The refusal for an assignment under a fence that is still standing. */
export function transferInProgress(assetId: string): RastaError {
  return RastaError.businessRule(
    'This machine is being transferred to another organization and cannot be assigned.',
    { rule: 'ASSET_TRANSFER_IN_PROGRESS', assetId, owner: ASSET_SERVICE },
  );
}
