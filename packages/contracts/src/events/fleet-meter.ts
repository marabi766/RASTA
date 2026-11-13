import { z } from 'zod';
import { meterReconcileOperatorSchema } from './maintenance-meter';

export const FLEET_METER_INVENTORY_SEALED = 'FLEET_METER_INVENTORY_SEALED';
export const fleetMeterInventorySealedPayloadV1 = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    operatorId: meterReconcileOperatorSchema,
    inventoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceBoundary: z.string().regex(/^[!-~]{1,256}$/),
    assetCount: z.number().int().nonnegative().max(20_000),
  })
  .strict();
