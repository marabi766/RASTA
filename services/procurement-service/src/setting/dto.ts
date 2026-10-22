import { z } from 'zod';
import { SHORTFALL_POLICIES } from '../config/env';
import { MAX_QUANTITY, settingSnapshotSchema } from '../demand/dto';

/** The longest window: a year (the environment default's bound, plan PR 3). */
export const MAX_WINDOW_HOURS = 8760;

/**
 * A new version of the caller organization's aggregation settings (ADR-070 plan PR 3, Q-119 (2)).
 *
 * The bounds are the plan's R2-1, as the environment defaults and the database hold them: the length
 * 1 to 8760 hours; the threshold 0 to MAX_QUANTITY — above the most a window can hold it would never
 * be reached, and EXTEND would extend that window forever, its snapshot beyond the reach of any later
 * setting.
 *
 * `expectedCurrentVersion` is the version the caller saw in force (null: none — the environment
 * defaults): a precondition, judged against the current version when the new one is written, so two
 * people who each read version n cannot both record n + 1 — the second is 409 OPTIMISTIC_LOCK_FAILED
 * and reads again (the lesson of #328 r1). Part of the body, so of the Idempotency-Key fingerprint.
 */
export const recordAggregationSettingSchema = z
  .object({
    windowHours: z
      .number()
      .int()
      .min(1)
      .max(MAX_WINDOW_HOURS)
      .describe('How long a window stays open from the demand that opens it, in hours.'),
    minQuantity: z
      .number()
      .int()
      .min(0)
      .max(MAX_QUANTITY)
      .describe(
        'The total quantity — a quantity, never an amount (Q-10) — a window must reach to be ' +
          'READY. 0 = no threshold. Never above MAX_QUANTITY, so a window can reach it.',
      ),
    shortfallPolicy: z
      .enum(SHORTFALL_POLICIES)
      .describe(
        'What a window that ends short of the threshold does: EXTEND (carried into the next ' +
          'window), REFER (a fact only) or CLOSE.',
      ),
    expectedCurrentVersion: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe(
        'The setting version the caller saw in force, or null when none was (the environment ' +
          'defaults). Any other current version is 409 OPTIMISTIC_LOCK_FAILED and nothing is written.',
      ),
  })
  .strict();
export type RecordAggregationSettingDto = z.infer<typeof recordAggregationSettingSchema>;

/** The settings in force for the windows the caller organization opens from now on. */
export const aggregationSettingViewSchema = settingSnapshotSchema
  .extend({
    recordedAt: z
      .string()
      .nullable()
      .describe(
        'When that version was recorded (UTC, ISO 8601 with Z), or null for the environment defaults.',
      ),
  })
  .strict();
export type AggregationSettingView = z.infer<typeof aggregationSettingViewSchema>;
