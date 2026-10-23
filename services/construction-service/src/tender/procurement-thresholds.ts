import { z } from 'zod';
import { amountMinorInput } from '../project/dto';

/** Organization governance key; the value is inherited and versioned by organization-service. */
export const PROCUREMENT_THRESHOLDS_KEY = 'construction.tender.procurement_thresholds';
export const PROCUREMENT_THRESHOLD_WARNING = 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE';

const entry = z
  .object({
    minAmountMinor: amountMinorInput.nullable(),
    maxAmountMinor: amountMinorInput.nullable(),
    mode: z.enum(['WARN', 'REJECT']),
  })
  .strict()
  .refine(
    (value) =>
      value.minAmountMinor === null ||
      value.maxAmountMinor === null ||
      !/^\d+$/.test(value.minAmountMinor) ||
      !/^\d+$/.test(value.maxAmountMinor) ||
      BigInt(value.minAmountMinor) <= BigInt(value.maxAmountMinor),
    { message: 'Minimum must not exceed maximum' },
  );

/** All four choices must be covered; null bounds are unbounded, endpoints inclusive. */
export const procurementThresholdsSchema = z
  .object({
    FORMAL_TENDER: entry,
    INQUIRY: entry,
    RFP: entry,
    MARKETPLACE_DEAL: entry,
  })
  .strict();
export type ProcurementThresholds = z.infer<typeof procurementThresholdsSchema>;
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
