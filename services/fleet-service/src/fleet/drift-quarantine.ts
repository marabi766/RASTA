import { EventHandlingUnconfirmedError, UnprocessableEventError } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { driftEvidenceOwnerChangesTotal } from '@rasta/observability';
import { createHash } from 'node:crypto';

const ACTIVATION_RETRY_ATTEMPTS = 8;
const ACTIVATION_RETRY_BACKOFF_MS = 10_000;

export class SourceDriftRefusal extends EventHandlingUnconfirmedError {
  constructor(
    readonly reason: UnprocessableEventError['reason'],
    readonly assetId: string,
    readonly namedOwner: string,
  ) {
    super(reason);
  }
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
  ) => Promise<T | SourceDriftRefusal>,
  eventId: string,
  fn: (tx: ExtendedPrismaClient) => Promise<T>,
  cleanup?: SourceDriftCleanup,
): Promise<T> {
  let ownerChanged = false;
  let refused = false;
  let callbackReturned = false;
  let entered = false;
  let refusal: SourceDriftRefusal | undefined;
  let result: T | SourceDriftRefusal;
  try {
    result = await transaction(async (tx) => {
      const [gate] = await tx.$queryRaw<{ run_id: string | null }[]>`
        SELECT run_id FROM meter_inventory_seal WHERE id = true FOR SHARE NOWAIT`;
      if (!gate) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
      // Sweep ownership must survive rollback, including before evidence capacity is locked.
      await cleanup?.lock(tx);
      await tx.$executeRaw`SAVEPOINT source_event_effects`;
      try {
        entered = true;
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
    if (refused || !entered) {
      // Seven pauses of at least 10s exceed tx2 (30s), tx1/pool and token release.
      // No seal dependency: missing gates and expired activation tokens need evidence too.
      const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
      throw new EventHandlingUnconfirmedError('SOURCE_DRIFT_QUARANTINE_UNCONFIRMED', error, {
        attempts: ACTIVATION_RETRY_ATTEMPTS,
        backoffMs: ACTIVATION_RETRY_BACKOFF_MS,
        persist: async () => {
          await transaction(async (tx) => {
            await tx.$executeRaw`INSERT INTO meter_drift_overflow
              (event_id, asset_id, named_owner, reason, run_id)
              VALUES (${`HOLD:${hash(eventId)}`}, ${hash(refusal?.assetId ?? eventId)},
                'PLATFORM', 'SOURCE_DRIFT_HOLD', 'UNCONFIRMED') ON CONFLICT (event_id) DO NOTHING`;
            return undefined as T;
          });
        },
      });
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
