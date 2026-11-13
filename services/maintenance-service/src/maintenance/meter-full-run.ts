import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MAINTENANCE_METER_FULL_RUN_ACTIVATED,
  MAINTENANCE_METER_FULL_RUN_ACTIVATED_VERSION,
  maintenanceMeterFullRunPayloadV1,
  meterReconcileOperatorSchema,
} from '@rasta/contracts';
import {
  createSystemContext,
  runUnscoped,
  runWithContext,
  tryGetContext,
} from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { MAINTENANCE_TOPIC } from '../config/env';
import { MaintenanceRepository } from './maintenance.repository';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const inventorySchema = z
  .object({
    complete: z.literal(true),
    scope: z.literal('ALL_PHYSICAL_ASSETS'),
    boundary: maintenanceMeterFullRunPayloadV1.shape.sourceBoundary,
    assets: z
      .array(z.object({ assetId: identifier, organizationId: identifier }).strict())
      .max(20_000),
  })
  .strict();
const refusalsSchema = z
  .array(
    z
      .object({
        assetId: identifier,
        reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      })
      .strict(),
  )
  .max(20_000);

/**
 * Trusted owner adapter contract, NOT a caller-supplied manifest. Must enumerate
 * every physical asset (including historical/transferred usage), and fence the
 * source's future-creation boundary until commit/rollback of the callback.
 * No production adapter/CLI is wired in this slice: unavailable authority refuses.
 */
export interface MeterInventoryAuthority {
  // A run must re-serve its original durable seal, never enumerate a fresh one.
  withSealedInventory<T>(runId: string, commit: (inventory: unknown) => Promise<T>): Promise<T>;
}
export class MeterFullRunRefusal extends Error {}

export interface MeterFullRunStatus {
  runId: string;
  inventoryDigest: string;
  sourceBoundary: string;
  assetCount: number;
  refusedCount: number;
}

/** Global operator command, never callable from an ambient tenant request. */
export class MeterFullRun {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority?: MeterInventoryAuthority,
  ) {}

  async status(runId: string, operatorId: string): Promise<MeterFullRunStatus | null> {
    if (tryGetContext()) throw new MeterFullRunRefusal('OPERATOR_CONTEXT_REQUIRED');
    identifier.parse(runId);
    meterReconcileOperatorSchema.parse(operatorId);
    return runUnscoped(
      'operator-only activation evidence; no per-asset or tenant output',
      async () => {
        const [gate] = await this.prisma.client.$queryRaw<
          (MeterFullRunStatus & { operatorId: string })[]
        >`SELECT run_id AS "runId", operator_id AS "operatorId", inventory_digest AS "inventoryDigest",
        source_boundary AS "sourceBoundary", (SELECT count(*)::int FROM meter_full_run_asset) AS "assetCount",
        (SELECT count(*)::int FROM meter_full_run_asset WHERE outcome = 'REFUSED') AS "refusedCount"
        FROM meter_full_run WHERE id = true`;
        if (!gate) throw new MeterFullRunRefusal('FULL_RUN_GATE_MISSING');
        if (gate.runId === null) return null;
        if (gate.runId !== runId || gate.operatorId !== operatorId)
          throw new MeterFullRunRefusal('FULL_RUN_CONFLICT');
        const { operatorId: _operator, ...status } = gate;
        return status;
      },
    );
  }

  async activate(runId: string, operatorId: string, explicitRefusals: unknown): Promise<string> {
    if (tryGetContext()) throw new MeterFullRunRefusal('OPERATOR_CONTEXT_REQUIRED');
    identifier.parse(runId);
    meterReconcileOperatorSchema.parse(operatorId);
    const refusals = refusalsSchema.parse(explicitRefusals);
    if (!this.authority) throw new MeterFullRunRefusal('AUTHORITATIVE_INVENTORY_REQUIRED');
    let confirmed = false;
    return this.authority
      .withSealedInventory(runId, async (value) => {
        const inventory = inventorySchema.parse(value);
        const assets = [...inventory.assets].sort((a, b) =>
          a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
        );
        const refused = new Map(refusals.map((r) => [r.assetId, r.reason]));
        const ids = new Set(assets.map((a) => a.assetId));
        if (
          ids.size !== assets.length ||
          refused.size !== refusals.length ||
          refusals.some((r) => !ids.has(r.assetId))
        )
          throw new MeterFullRunRefusal('INVENTORY_CONFLICT');
        const outcomes = assets.map((a) => ({
          ...a,
          outcome: refused.has(a.assetId) ? 'REFUSED' : 'LEDGER',
          refusal: refused.get(a.assetId) ?? null,
        }));
        const digest = createHash('sha256')
          .update(JSON.stringify({ boundary: inventory.boundary, outcomes }))
          .digest('hex');
        const appliedRun = await runWithContext(
          createSystemContext({
            correlationId: runId,
            userId: operatorId,
            callerService: 'maintenance-service',
          }),
          async () =>
            runUnscoped(
              'global operator rollout inventory; physical assets across owners, no tenant-facing reads',
              async () => {
                let callbackReturned = false;
                try {
                  return await this.prisma.transaction(
                    async (tx) => {
                      const [gate] = await tx.$queryRaw<
                        {
                          run_id: string | null;
                          inventory_digest: string | null;
                          operator_id: string | null;
                        }[]
                      >`
                SELECT run_id, inventory_digest, operator_id FROM meter_full_run WHERE id = true FOR UPDATE`;
                      if (!gate) throw new MeterFullRunRefusal('FULL_RUN_GATE_MISSING');
                      if (gate.run_id !== null) {
                        if (gate.run_id !== runId || gate.operator_id !== operatorId)
                          throw new MeterFullRunRefusal('FULL_RUN_CONFLICT');
                        if (gate.inventory_digest !== digest)
                          throw new MeterFullRunRefusal('ALREADY_ACTIVE_INVENTORY_DRIFT');
                        callbackReturned = true;
                        return runId;
                      }
                      // The INSERT trigger holds FOR SHARE until its transaction ends.
                      // Check locally visible facts/meters/replicas; asset_ref itself is not fenced.
                      // Source completeness and future creations require the owner seal.
                      const [check] = await tx.$queryRaw<{ invalid: boolean }[]>`
                WITH inventory AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(outcomes)}::jsonb)
                  AS x("assetId" text, "organizationId" text, outcome text, refusal text)),
                local_assets AS (SELECT id AS asset_id FROM asset_ref UNION SELECT asset_id FROM asset_usage_meter
                  UNION SELECT asset_id FROM asset_usage_entry)
                SELECT EXISTS (SELECT 1 FROM local_assets l WHERE NOT EXISTS
                  (SELECT 1 FROM inventory i WHERE i."assetId" = l.asset_id)) OR EXISTS
                  (SELECT 1 FROM inventory i WHERE i.outcome <> 'REFUSED' AND NOT EXISTS
                    (SELECT 1 FROM asset_usage_meter m WHERE m.asset_id = i."assetId" AND m.meter_source = 'LEDGER')) AS invalid`;
                      if (check.invalid) throw new MeterFullRunRefusal('FULL_RUN_INCOMPLETE');
                      await tx.$executeRaw`
                INSERT INTO meter_full_run_asset(asset_id, organization_id, outcome, refusal)
                SELECT "assetId", "organizationId", outcome, refusal FROM jsonb_to_recordset(${JSON.stringify(outcomes)}::jsonb)
                  AS x("assetId" text, "organizationId" text, outcome text, refusal text)`;
                      await new MaintenanceRepository(this.prisma).enqueueEvent(tx, {
                        organizationId: null,
                        aggregateType: 'MeterFullRun',
                        aggregateId: runId,
                        eventName: MAINTENANCE_METER_FULL_RUN_ACTIVATED,
                        eventVersion: MAINTENANCE_METER_FULL_RUN_ACTIVATED_VERSION,
                        topic: MAINTENANCE_TOPIC,
                        payload: maintenanceMeterFullRunPayloadV1.parse({
                          runId,
                          operatorId,
                          before: 'INACTIVE',
                          after: 'ACTIVE',
                          inventoryDigest: digest,
                          sourceBoundary: inventory.boundary,
                          assetCount: outcomes.length,
                          refusedCount: refused.size,
                        }),
                      });
                      await tx.$executeRaw`UPDATE meter_full_run SET run_id = ${runId}, operator_id = ${operatorId},
                inventory_digest = ${digest}, source_boundary = ${inventory.boundary}, activated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
                WHERE id = true`;
                      callbackReturned = true;
                      return runId;
                    },
                    { timeoutMs: 30_000 },
                  );
                } catch (error) {
                  if (error instanceof MeterFullRunRefusal) throw error;
                  // Prisma cannot commit until our callback returns. Pool acquisition,
                  // statement errors and callback timeouts therefore prove refusal.
                  if (!callbackReturned) throw new MeterFullRunRefusal('FULL_RUN_PRECOMMIT_FAILED');
                  throw new Error('FULL_RUN_UNCONFIRMED');
                }
              },
            ),
        );
        confirmed = true;
        return appliedRun;
      })
      .then(
        (result) => {
          if (!confirmed || result !== runId) throw new Error('FULL_RUN_UNCONFIRMED');
          return result;
        },
        (error: unknown) => {
          // An owner fence/release error cannot erase a confirmed maintenance commit.
          if (confirmed) throw new Error('FULL_RUN_UNCONFIRMED');
          throw error;
        },
      );
  }
}
