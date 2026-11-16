import {
  EventHandlingUnconfirmedError,
  UnprocessableEventError,
  handlingFailureCause,
} from '@rasta/nest-common';
import { SOURCE_REFUSAL_HISTORY_TRANSACTION } from '../config/source-evidence-policy';
import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { driftEvidenceOwnerChangesTotal } from '@rasta/observability';
import { createHash } from 'node:crypto';

import {
  ACTIVATION_RETRY_ATTEMPTS,
  ACTIVATION_RETRY_BACKOFF_MS,
} from '../config/source-evidence-policy';

export class SourceDriftRefusal extends EventHandlingUnconfirmedError {
  constructor(
    readonly reason: UnprocessableEventError['reason'],
    readonly assetId: string,
    readonly namedOwner: string,
  ) {
    super(reason);
  }
}

export class SourceEvidenceUnconfirmedError extends EventHandlingUnconfirmedError {
  historyWriteFailure?: Error;
}

export interface SourceDriftCleanup {
  lock(tx: ExtendedPrismaClient): Promise<void>;
  discard(tx: ExtendedPrismaClient): Promise<void>;
}

/** Seal and cleanup locks precede savepoint: refused effects roll back.
 * Quarantine and terminal cleanup commit together.
 * The authority's exclusive seal lock excludes this entire decision, including rollback.
 */
export async function quarantineTransaction<T>(
  transaction: (
    fn: (tx: ExtendedPrismaClient) => Promise<T | SourceDriftRefusal>,
    options?: { timeoutMs: number; maxWaitMs: number },
  ) => Promise<T | SourceDriftRefusal>,
  eventId: string,
  fn: (tx: ExtendedPrismaClient) => Promise<T>,
  cleanup?: SourceDriftCleanup,
  sourceAssetId?: string,
): Promise<T> {
  let ownerChanged = false;
  let refused = false;
  let callbackReturned = false;
  let evidenceCause = false;
  let refusal: SourceDriftRefusal | undefined;
  let result: T | SourceDriftRefusal;
  try {
    result = await transaction(async (tx) => {
      const [gate] = await tx.$queryRaw<{ run_id: string | null }[]>`
        SELECT run_id FROM meter_inventory_seal WHERE id = true FOR SHARE NOWAIT`.catch(
        (error: unknown) => {
          // Only NOWAIT on this exact seal query enters the evidence window.
          evidenceCause =
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2010' &&
            error.meta?.code === '55P03';
          throw error;
        },
      );
      if (!gate) {
        evidenceCause = true;
        throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
      }
      // Sweep ownership must survive rollback, including before evidence capacity is locked.
      await cleanup?.lock(tx);
      await tx.$executeRaw`SAVEPOINT source_event_effects`;
      try {
        const value = await fn(tx);
        callbackReturned = true;
        return value;
      } catch (error) {
        if (!(error instanceof SourceDriftRefusal)) throw error;
        refused = true;
        refusal = error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT source_event_effects`;
        if (!gate.run_id) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
        // Terminal sweep cleanup shares the evidence commit; failure preserves the parked row.
        await cleanup?.discard(tx);
        await tx.$executeRaw`INSERT INTO meter_drift_quarantine
          (event_id, asset_id, sealed_owner, named_owner, reason, run_id)
          VALUES (${eventId}, ${error.assetId},
            (SELECT organization_id FROM meter_inventory_seal_asset WHERE asset_id = ${error.assetId}),
            ${error.namedOwner}, ${error.reason}, ${gate.run_id}) ON CONFLICT (event_id) DO NOTHING`;
        // Commit the permanent marker with either primary or overflow evidence.
        await tx.$executeRaw`INSERT INTO meter_refusal_history(event_hash)
          VALUES (${sourceEventHash(eventId)}) ON CONFLICT DO NOTHING`;
        const [overflow] = await tx.$queryRaw<{ present: boolean; owner_changed: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM meter_drift_overflow WHERE event_id = ${eventId}) AS present,
            EXISTS(SELECT 1 FROM (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) q
              WHERE event_id = ${eventId} AND named_owner IS DISTINCT FROM ${error.namedOwner}) AS owner_changed`;
        ownerChanged = overflow.owner_changed;
        return overflow.present
          ? new SourceDriftRefusal('SOURCE_DRIFT_QUARANTINE_FULL', error.assetId, error.namedOwner)
          : error;
      }
    });
  } catch (error) {
    if (refused || evidenceCause) {
      // Commit independently: neither a held seal nor a stale parked version can erase this.
      // A failed/lost marker response keeps the existing evidence window fail-closed.
      let historyWriteFailure: Error | undefined;
      await transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO meter_refusal_history(event_hash)
          VALUES (${sourceEventHash(eventId)}) ON CONFLICT DO NOTHING`;
        return undefined as T;
      }, SOURCE_REFUSAL_HISTORY_TRANSACTION).catch((failure: unknown) => {
        historyWriteFailure = handlingFailureCause(failure);
      });
      // Seven pauses of at least 10s exceed tx2 (30s), tx1/pool and token release.
      // No seal dependency: missing gates and expired activation tokens need evidence too.
      const unconfirmed = new SourceEvidenceUnconfirmedError(
        'SOURCE_DRIFT_QUARANTINE_UNCONFIRMED',
        error,
        {
          attempts: ACTIVATION_RETRY_ATTEMPTS,
          backoffMs: ACTIVATION_RETRY_BACKOFF_MS,
          persist: (lastError) =>
            persistSourceDriftHold<T>(
              (work) => transaction(work, SOURCE_REFUSAL_HISTORY_TRANSACTION),
              eventId,
              refusal?.assetId ?? sourceAssetId,
              lastError instanceof EventHandlingUnconfirmedError && lastError.evidencePolicy
                ? 'SOURCE_REFUSAL_UNCONFIRMED'
                : 'SOURCE_INFRASTRUCTURE_DURING_REFUSAL',
            ),
        },
      );
      unconfirmed.historyWriteFailure = historyWriteFailure;
      throw unconfirmed;
    }
    if (callbackReturned)
      throw new EventHandlingUnconfirmedError('SOURCE_WRITE_UNCONFIRMED', error);
    throw error;
  }
  if (ownerChanged) driftEvidenceOwnerChangesTotal.inc();
  if (result instanceof SourceDriftRefusal)
    throw new UnprocessableEventError(result.reason, result.reason);
  return result;
}

export const sourceEventHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Reserved HOLD namespace cannot equal a seal run ID; PostgreSQL counts later writes. */
export type SourceHoldCause = 'SOURCE_REFUSAL_UNCONFIRMED' | 'SOURCE_INFRASTRUCTURE_DURING_REFUSAL';

export async function persistSourceDriftHold<T>(
  transaction: (
    fn: (tx: ExtendedPrismaClient) => Promise<T | SourceDriftRefusal>,
  ) => Promise<T | SourceDriftRefusal>,
  eventId: string,
  assetId: string | undefined,
  cause: SourceHoldCause,
): Promise<void> {
  await transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO meter_drift_overflow
      (event_id, asset_id, named_owner, reason, run_id)
      VALUES (${`HOLD:${sourceEventHash(eventId)}`}, ${sourceEventHash(assetId ?? eventId)},
        'PLATFORM', 'SOURCE_DRIFT_HOLD', ${`HOLD:${cause}:0`}) ON CONFLICT (event_id) DO NOTHING`;
    return undefined as T;
  });
}
