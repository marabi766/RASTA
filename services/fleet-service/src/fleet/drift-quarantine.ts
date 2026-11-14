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

/** Seal lock precedes savepoint: refused effects roll back, quarantine alone commits.
 * The authority's exclusive seal lock excludes this entire decision, including rollback.
 */
export async function quarantineTransaction<T>(
  transaction: (
    fn: (tx: ExtendedPrismaClient) => Promise<T | SourceDriftRefusal>,
  ) => Promise<T | SourceDriftRefusal>,
  eventId: string,
  fn: (tx: ExtendedPrismaClient) => Promise<T>,
): Promise<T> {
  let refused = false;
  let result: T | SourceDriftRefusal;
  try {
    result = await transaction(async (tx) => {
      const [gate] = await tx.$queryRaw<{ run_id: string | null }[]>`
        SELECT run_id FROM meter_inventory_seal WHERE id = true FOR SHARE`;
      if (!gate) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
      await tx.$executeRaw`SAVEPOINT source_event_effects`;
      try {
        return await fn(tx);
      } catch (error) {
        if (!(error instanceof SourceDriftRefusal)) throw error;
        refused = true;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT source_event_effects`;
        if (!gate.run_id) throw new EventHandlingUnconfirmedError('SOURCE_FENCE_MISSING');
        await tx.$executeRaw`INSERT INTO meter_drift_quarantine
          (event_id, asset_id, sealed_owner, named_owner, reason, run_id)
          VALUES (${eventId}, ${error.assetId},
            (SELECT organization_id FROM meter_inventory_seal_asset WHERE asset_id = ${error.assetId}),
            ${error.namedOwner}, ${error.reason}, ${gate.run_id}) ON CONFLICT (event_id) DO NOTHING`;
        return error;
      }
    });
  } catch (error) {
    // Includes cap/write failures and ambiguous COMMIT: no transport DLQ without evidence.
    if (refused) {
      const full =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        error.meta?.code === 'P0001' &&
        error.meta?.message === 'ERROR: SOURCE_DRIFT_QUARANTINE_FULL';
      throw new EventHandlingUnconfirmedError(
        full ? 'SOURCE_DRIFT_QUARANTINE_FULL' : 'SOURCE_DRIFT_QUARANTINE_UNCONFIRMED',
      );
    }
    throw error;
  }
  if (result instanceof SourceDriftRefusal)
    throw new UnprocessableEventError(result.reason, result.reason);
  return result;
}
