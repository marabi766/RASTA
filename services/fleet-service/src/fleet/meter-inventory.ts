import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FLEET_METER_INVENTORY_SEALED,
  fleetMeterInventorySealedPayloadV1,
  meterReconcileOperatorSchema,
} from '@rasta/contracts';
import {
  createSystemContext,
  runUnscoped,
  runWithContext,
  tryGetContext,
} from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { FLEET_TOPIC } from '../config/env';
import { FleetRepository } from './fleet.repository';
import { Prisma } from '../generated/prisma';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const assetsSchema = z
  .array(z.object({ assetId: identifier, organizationId: identifier }).strict())
  .max(20_000);
export interface FleetMeterInventory {
  complete: true;
  scope: 'ALL_PHYSICAL_ASSETS';
  boundary: string;
  assets: z.infer<typeof assetsSchema>;
}
export class FleetMeterInventoryRefusal extends Error {}

/** Durable source fence, with no activation or release path in this slice. */
export class FleetMeterInventorySeal {
  constructor(private readonly prisma: PrismaService) {}

  async seal(runId: string, operatorId: string): Promise<FleetMeterInventory> {
    if (tryGetContext()) throw new FleetMeterInventoryRefusal('OPERATOR_CONTEXT_REQUIRED');
    identifier.parse(runId);
    meterReconcileOperatorSchema.parse(operatorId);
    return runWithContext(
      createSystemContext({
        correlationId: runId,
        userId: operatorId,
        callerService: 'fleet-service',
      }),
      async () =>
        runUnscoped(
          'global operator source seal; all physical fleet identities across historical owners, never tenant-facing',
          async () => {
            try {
              return await this.prisma.transaction(
                async (tx) => {
                  // A sealed gate is immutable: replay needs no source or gate row locks.
                  let [gate] = await tx.$queryRaw<
                    {
                      run_id: string | null;
                      operator_id: string | null;
                      inventory: unknown;
                      boundary: string | null;
                      isolation_level: string;
                    }[]
                  >`
              SELECT run_id, operator_id, inventory, boundary, current_setting('transaction_isolation') AS isolation_level
              FROM meter_inventory_seal WHERE id = true`;
                  if (!gate) throw new FleetMeterInventoryRefusal('SOURCE_FENCE_MISSING');
                  if (gate.isolation_level !== 'read committed')
                    throw new FleetMeterInventoryRefusal('SOURCE_FENCE_REQUIRES_READ_COMMITTED');
                  if (gate.run_id === null) {
                    // Never queue behind a reverse-order multi-table writer. Release all acquired
                    // locks on refusal, then retry the SAME run after draining source writers.
                    await tx.$executeRaw`LOCK TABLE asset_ref, usage_record, assignment, availability_window,
              asset_transfer_fence, asset_transfer_release, insurance_pending_verification,
              meter_inventory_seal_asset IN SHARE MODE NOWAIT`;
                    [gate] = await tx.$queryRaw<(typeof gate)[]>`
              SELECT run_id, operator_id, inventory, boundary, current_setting('transaction_isolation') AS isolation_level
              FROM meter_inventory_seal WHERE id = true FOR UPDATE NOWAIT`;
                    if (!gate) throw new FleetMeterInventoryRefusal('SOURCE_FENCE_MISSING');
                  }
                  if (gate.run_id !== null) {
                    if (gate.run_id !== runId || gate.operator_id !== operatorId)
                      throw new FleetMeterInventoryRefusal('SOURCE_SEAL_CONFLICT');
                    const assets = assetsSchema.parse(gate.inventory);
                    const digest = createHash('sha256')
                      .update(JSON.stringify(assets))
                      .digest('hex');
                    const expectedBoundary = `fleet:${runId}:${digest}`;
                    if (gate.boundary !== expectedBoundary)
                      throw new FleetMeterInventoryRefusal('SOURCE_SEAL_INVALID');
                    return {
                      complete: true,
                      scope: 'ALL_PHYSICAL_ASSETS',
                      boundary: gate.boundary,
                      assets,
                    };
                  }
                  const rows = await tx.$queryRaw<
                    { assetId: string; organizationId: string | null }[]
                  >`
              WITH identities AS (
                SELECT id AS asset_id, organization_id FROM asset_ref
                UNION SELECT asset_id, organization_id FROM usage_record
                UNION SELECT asset_id, organization_id FROM assignment
                UNION SELECT asset_id, organization_id FROM availability_window
                UNION SELECT asset_id, organization_id FROM asset_transfer_fence
                UNION SELECT asset_id, organization_id FROM asset_transfer_release
                UNION SELECT asset_id, organization_id FROM insurance_pending_verification
              ) SELECT i.asset_id AS "assetId", COALESCE(max(a.organization_id),
                CASE WHEN count(DISTINCT i.organization_id) = 1 THEN min(i.organization_id) END) AS "organizationId"
              FROM identities i LEFT JOIN asset_ref a ON a.id = i.asset_id
              GROUP BY i.asset_id ORDER BY i.asset_id COLLATE "C" LIMIT 20001`;
                  if (rows.length > 20_000)
                    throw new FleetMeterInventoryRefusal('SOURCE_INVENTORY_TOO_LARGE');
                  if (rows.some((r) => r.organizationId === null))
                    throw new FleetMeterInventoryRefusal('SOURCE_OWNER_UNCONFIRMED');
                  const assets = assetsSchema.parse(rows);
                  const digest = createHash('sha256').update(JSON.stringify(assets)).digest('hex');
                  const boundary = `fleet:${runId}:${digest}`;
                  await new FleetRepository(this.prisma).enqueueEvent(tx, {
                    organizationId: null,
                    aggregateType: 'MeterInventorySeal',
                    aggregateId: runId,
                    eventName: FLEET_METER_INVENTORY_SEALED,
                    eventVersion: 1,
                    topic: FLEET_TOPIC,
                    payload: fleetMeterInventorySealedPayloadV1.parse({
                      runId,
                      operatorId,
                      inventoryDigest: digest,
                      sourceBoundary: boundary,
                      assetCount: assets.length,
                    }),
                  });
                  await tx.$executeRaw`UPDATE meter_inventory_seal SET run_id = ${runId}, operator_id = ${operatorId},
              inventory = ${JSON.stringify(assets)}::jsonb, boundary = ${boundary} WHERE id = true`;
                  return { complete: true, scope: 'ALL_PHYSICAL_ASSETS', boundary, assets };
                },
                { timeoutMs: 30_000 },
              );
            } catch (error) {
              if (error instanceof FleetMeterInventoryRefusal) throw error;
              if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                (error.code === 'P2034' || ['55P03', '40P01'].includes(String(error.meta?.code)))
              )
                throw new FleetMeterInventoryRefusal('SOURCE_WRITERS_ACTIVE');
              // The seal/outbox may have committed. Reconcile by replaying the SAME run and actor.
              throw new Error('SOURCE_SEAL_UNCONFIRMED');
            }
          },
        ),
    );
  }
}
