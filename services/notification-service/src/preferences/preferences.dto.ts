import { z } from 'zod';
import { NOTIFICATION_CATEGORIES } from '../rules/rules';

/**
 * The preference API's inputs (ADR-054 § 5).
 *
 * Validation is at the boundary and schema-based, and two of these rules are
 * not conveniences:
 *
 *   * `scopeKey` is required exactly when the scope is not `GLOBAL`, and the
 *     database refuses the other shapes too (`ck_preference_scope_key_shape`).
 *     Validating it here means the caller gets `400` naming the field rather
 *     than a `500` from a constraint they cannot see.
 *   * A `CATEGORY` key must be a category this service knows. A free string
 *     would store a row the ladder never looks for — present in the table,
 *     invisible in effect, and impossible to explain to the person who set it.
 */

export const PREFERENCE_SCOPES = ['GLOBAL', 'CATEGORY', 'RULE'] as const;

/** The only channel the platform can deliver on today. */
export const PREFERENCE_CHANNELS = ['IN_APP'] as const;

const scopeSchema = z.enum(PREFERENCE_SCOPES);
const channelSchema = z.enum(PREFERENCE_CHANNELS);

/** One row a caller wants to exist. */
export const preferenceInputSchema = z
  .object({
    scope: scopeSchema,
    /** Null or absent for `GLOBAL`; a category name or a `ruleKey` otherwise. */
    scopeKey: z.string().min(1).max(128).nullish(),
    channel: channelSchema,
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'GLOBAL') {
      if (value.scopeKey !== undefined && value.scopeKey !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopeKey'],
          message: 'A GLOBAL preference covers the whole channel and takes no key',
        });
      }
      return;
    }

    if (value.scopeKey === undefined || value.scopeKey === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeKey'],
        message: `A ${value.scope} preference needs the ${
          value.scope === 'RULE' ? 'rule key' : 'category'
        } it applies to`,
      });
      return;
    }

    if (
      value.scope === 'CATEGORY' &&
      !(NOTIFICATION_CATEGORIES as readonly string[]).includes(value.scopeKey)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeKey'],
        message: `Unknown category; expected one of ${NOTIFICATION_CATEGORIES.join(', ')}`,
      });
    }
  });

export type PreferenceInput = z.infer<typeof preferenceInputSchema>;

/**
 * A whole replacement of the caller's preferences for this tenant.
 *
 * `PUT` rather than `PATCH`, because a settings screen sends what it shows and
 * a partial update would leave rows the user believes they removed. The bound
 * is generous but finite: a person cannot hold more preferences than there are
 * rules and categories, and an unbounded body is a denial-of-service surface.
 */
export const replacePreferencesSchema = z
  .object({
    preferences: z.array(preferenceInputSchema).max(200),
  })
  .strict();

export type ReplacePreferencesDto = z.infer<typeof replacePreferencesSchema>;

/** What `GET /v1/preferences/effective` is asked about. */
export const effectiveQuerySchema = z
  .object({
    ruleKey: z.string().min(1).max(128),
    channel: channelSchema.default('IN_APP'),
  })
  .strict();

export type EffectiveQuery = z.infer<typeof effectiveQuerySchema>;
