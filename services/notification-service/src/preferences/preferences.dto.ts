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

/**
 * The channels the platform can deliver on, and therefore the only ones a
 * person may express a preference about.
 *
 * `EMAIL` joined the list with the worker that sends it (NTF-004). Offering a
 * preference for a channel that cannot deliver would be a control claiming an
 * effect it does not have — the Q-07 argument this service has applied to an
 * enum value, a configuration flag and a stored row, and the reason this list
 * still does not contain `SMS`.
 */
export const PREFERENCE_CHANNELS = ['IN_APP', 'EMAIL'] as const;

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

/**
 * A quiet window, as a person sets it (NTF-004, ADR-054 § 5).
 *
 * Times are `HH:MM` on a 24-hour clock rather than minutes-from-midnight,
 * because that is what a settings screen shows and what a person can check.
 * The service converts; the database stores minutes, which is what the
 * comparison actually needs.
 *
 * `null` means "no quiet window", which is what every recipient has until they
 * say otherwise. It is a separate concept from a window of zero length, and
 * the database refuses the latter outright.
 */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const quietHoursSchema = z
  .object({
    start: z.string().regex(CLOCK, 'Expected HH:MM on a 24-hour clock'),
    end: z.string().regex(CLOCK, 'Expected HH:MM on a 24-hour clock'),
    /**
     * An IANA zone name. Validated against the runtime's own database rather
     * than a list kept here: a zone this process cannot resolve would store a
     * window that can never be evaluated, and the failure would surface as a
     * notification that arrives at the wrong hour.
     */
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isKnownTimezone, 'Unknown IANA time zone')
      .default('Asia/Tehran'),
  })
  .strict()
  .refine((value) => value.start !== value.end, {
    message:
      'A window whose start equals its end is either zero minutes or the whole day; say which',
  });

export const replaceQuietHoursSchema = z
  .object({
    /** `null` clears the window. */
    quietHours: quietHoursSchema.nullable(),
  })
  .strict();

export type QuietHoursDto = z.infer<typeof quietHoursSchema>;
export type ReplaceQuietHoursDto = z.infer<typeof replaceQuietHoursSchema>;

function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` to minutes from local midnight, and back. */
export function clockToMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours as number) * 60 + (minutes as number);
}

export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
