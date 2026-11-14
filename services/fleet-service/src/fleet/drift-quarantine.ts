import { EventHandlingUnconfirmedError, UnprocessableEventError } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

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
  let refused = false;
  let callbackReturned = false;
  let result: T | SourceDriftRefusal;
  try {
    result = await transaction(async (tx) => {
      const [gate] = await tx.$queryRaw<{ run_id: string | null }[]>`
        SELECT run_id FROM meter_inventory_seal WHERE id = true FOR SHARE`;
      if (!gate) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
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
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT source_event_effects`;
        if (!gate.run_id) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
        // Terminal sweep cleanup shares the evidence commit; failure preserves the parked row.
        await cleanup?.discard(tx);
        await tx.$executeRaw`INSERT INTO meter_drift_quarantine
          (event_id, asset_id, sealed_owner, named_owner, reason, run_id)
          VALUES (${eventId}, ${error.assetId},
            (SELECT organization_id FROM meter_inventory_seal_asset WHERE asset_id = ${error.assetId}),
            ${error.namedOwner}, ${error.reason}, ${gate.run_id}) ON CONFLICT (event_id) DO NOTHING`;
        return error;
      }
    });
  } catch (error) {
    // Includes persistence failures and ambiguous COMMIT; retry/DLQ retains the unresolved classification.
    if (refused) {
      const full =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        error.meta?.code === 'P0001' &&
        error.meta?.message === 'ERROR: SOURCE_DRIFT_QUARANTINE_FULL';
      throw new EventHandlingUnconfirmedError(
        full ? 'SOURCE_DRIFT_QUARANTINE_FULL' : 'SOURCE_DRIFT_QUARANTINE_UNCONFIRMED',
        error,
      );
    }
    if (callbackReturned)
      throw new EventHandlingUnconfirmedError('SOURCE_WRITE_UNCONFIRMED', error);
    throw error;
  }
  if (result instanceof SourceDriftRefusal)
    throw new UnprocessableEventError(result.reason, result.reason);
  return result;
}
