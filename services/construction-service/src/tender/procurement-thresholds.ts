import { z } from 'zod';
import type { ProcurementThresholds } from '@rasta/contracts';
export { PROCUREMENT_THRESHOLDS_KEY, procurementThresholdsSchema } from '@rasta/contracts';
export type { ProcurementThresholds } from '@rasta/contracts';

export const PROCUREMENT_THRESHOLD_WARNING = 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE';
export const thresholdPreviewSchema = z
  .object({
    tenderVersion: z.number().int(),
    decision: z.enum(['PASS', 'WARN', 'REJECT', 'ESTIMATE_REQUIRED']),
    procurementThresholdPolicyId: z.string().nullable(),
  })
  .strict();
export type ThresholdPreview = z.infer<typeof thresholdPreviewSchema>;

export interface ThresholdPolicy {
  readonly id: string;
  readonly value: ProcurementThresholds;
}
export type ThresholdDecision = 'PASS' | 'WARN' | 'REJECT' | 'ESTIMATE_REQUIRED';

/** Validates a manual choice; never selects a nature or makes a legal determination. */
export function checkProcurementThreshold(
  policy: ThresholdPolicy | null,
  nature: keyof ProcurementThresholds | null,
  estimatedCostMinor: bigint | null,
): ThresholdDecision {
  if (policy === null || nature === null) return 'PASS';
  if (estimatedCostMinor === null) return 'ESTIMATE_REQUIRED';
  const range = policy.value[nature];
  const outside =
    (range.minAmountMinor !== null && estimatedCostMinor < BigInt(range.minAmountMinor)) ||
    (range.maxAmountMinor !== null && estimatedCostMinor > BigInt(range.maxAmountMinor));
  return outside ? range.mode : 'PASS';
}
