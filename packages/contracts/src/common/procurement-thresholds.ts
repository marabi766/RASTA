import { z } from 'zod';

/** The largest value a PostgreSQL BIGINT holds. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Rial minor units as a decimal string (AGENTS.md § 3). Never a number: an
 * estimate above 2^53 would lose precision in JSON.
 */
const amountMinorInput = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/, 'An amount is a non-negative integer string in rial minor units')
  // Zod runs a refinement even when the regex already failed, so it must not
  // assume a well-formed value: `BigInt('1.5')` throws rather than returning.
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= BIGINT_MAX,
    'The amount exceeds the largest storable value',
  );

/** Organization governance key; the value is inherited and versioned by organization-service. */
export const PROCUREMENT_THRESHOLDS_KEY = 'construction.tender.procurement_thresholds';

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
