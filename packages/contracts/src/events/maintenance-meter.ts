import { z } from 'zod';

export const MAINTENANCE_METER_RECONCILED = 'MAINTENANCE_METER_RECONCILED';
export const MAINTENANCE_METER_RECONCILED_VERSION = 1;
export const meterReconcileOperatorSchema = z.string().regex(/^[!-~]{1,256}$/);
const identifier = z.string().min(1).max(64);
const quantity = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/);
const state = z
  .object({
    mode: z.enum(['LEGACY', 'LEDGER']),
    hours: quantity,
    kilometres: quantity,
    recordCount: z.number().int().nonnegative(),
    lastPeriodEnd: z.iso.datetime().nullable(),
    lastUsageRecordId: identifier.nullable(),
  })
  .strict();

/** Version 1: bounded scalars retained verbatim in audit changes (ADR-053). */
export const maintenanceMeterReconciledPayloadV1 = z
  .object({
    assetId: identifier,
    organizationId: identifier,
    before: state,
    after: state.extend({ mode: z.literal('LEDGER') }),
    certificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: z
      .string()
      .max(2000)
      .regex(/^\d+:\d+:(\d+(,\d+)*)?$/),
    runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    operatorId: meterReconcileOperatorSchema,
  })
  .strict();
