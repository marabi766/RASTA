/**
 * The shape of the usage form: its field names, and a blank set of values.
 *
 * Separate from `server/usage.ts`, which parses and sends them, because that
 * module reaches the gateway client and therefore `node:crypto`. The form is
 * a client component and may import none of that — the build refuses it, and
 * the refusal is right: a browser bundle has no business containing the code
 * that talks to the gateway.
 */

export const USAGE_FIELDS = [
  'assetId',
  'periodStart',
  'periodEnd',
  'hours',
  'kilometres',
  'hourMeter',
  'odometer',
  'notes',
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];

/** What the form carries, as strings, before any interpretation. */
export type UsageFormValues = Readonly<Record<UsageField, string>>;

export const EMPTY_USAGE_FORM: UsageFormValues = {
  assetId: '',
  periodStart: '',
  periodEnd: '',
  hours: '',
  kilometres: '',
  hourMeter: '',
  odometer: '',
  notes: '',
};
