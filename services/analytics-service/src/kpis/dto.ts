import { z } from 'zod';
import { fleetDashboardQuerySchema } from '../maintenance/dto';
import { KPI_DEFINITIONS } from './definitions';

// Exactly PR 1's explicit [from, to) window and strict rejection of unknown parameters.
export const kpisQuerySchema = fleetDashboardQuerySchema;
export type KpisQuery = z.infer<typeof kpisQuerySchema>;

// Closed set. `INSUFFICIENT_BASELINE` is "there is no reference measurement to compare with";
// `NO_DATA` is "analytics cannot vouch for the whole window" (D-082). The two meanings are never
// merged: a baseline KPI never reports NO_DATA, and a count never reports INSUFFICIENT_BASELINE.
export const kpiStatusSchema = z.enum(['AVAILABLE', 'INSUFFICIENT_BASELINE', 'NO_DATA']);
export const kpiValueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('AVAILABLE'), value: z.string().regex(/^\d+$/) }).strict(),
  z.object({ status: z.literal('INSUFFICIENT_BASELINE'), value: z.literal(null) }).strict(),
  // No `value` key at all (omitted, not null): a zero must be impossible to read off a NO_DATA.
  z.object({ status: z.literal('NO_DATA') }).strict(),
]);
export type KpiValue = z.infer<typeof kpiValueSchema>;

const kpiMetadata = z
  .object({
    key: z.enum(
      KPI_DEFINITIONS.map((definition) => definition.key) as [
        (typeof KPI_DEFINITIONS)[number]['key'],
        ...(typeof KPI_DEFINITIONS)[number]['key'][],
      ],
    ),
    unit: z.enum(
      KPI_DEFINITIONS.map((definition) => definition.unit) as [
        (typeof KPI_DEFINITIONS)[number]['unit'],
        ...(typeof KPI_DEFINITIONS)[number]['unit'][],
      ],
    ),
    dependsOnBaseline: z.boolean(),
  })
  .strict();

// An ordinary Zod union is also emitted as anyOf by PR 1's OpenAPI converter. Status/value
// coupling is therefore enforced by both the runtime contract and the published contract.
const kpiSchema = z.union([
  kpiMetadata.extend({
    status: z.literal(kpiStatusSchema.enum.AVAILABLE),
    value: z.string().regex(/^\d+$/),
  }),
  kpiMetadata.extend({
    status: z.literal(kpiStatusSchema.enum.INSUFFICIENT_BASELINE),
    value: z.literal(null),
  }),
  kpiMetadata.extend({ status: z.literal(kpiStatusSchema.enum.NO_DATA) }),
]);

export const kpisViewSchema = z
  .object({
    organizationId: z.string(),
    from: z.string(),
    to: z.string(),
    earliestCompletionAt: z
      .string()
      .nullable()
      .describe(
        'Earliest completion held here in any window; null means no facts received. ' +
          'Informational only: it is not a coverage statement (a quiet tenant and an unknown one ' +
          'look alike), so no status is derived from it.',
      ),
    kpis: z.array(
      kpiSchema.describe(
        'MAINTENANCE_COMPLETED_COUNT: AVAILABLE only when the maintenance projection covers the ' +
          'whole window — enabled, running since before from, and the window has ended; then "0" ' +
          'means nothing was completed. Otherwise NO_DATA with no value field: analytics cannot ' +
          'vouch for the window, which is not the same as zero. Lag and dead letters are not ' +
          'proven by this rule (ADR-071 § 6).',
      ),
    ),
  })
  .strict();
export type KpisView = z.infer<typeof kpisViewSchema>;

export function baselineValue(value: string | null): KpiValue {
  return value === null
    ? { status: 'INSUFFICIENT_BASELINE', value: null }
    : { status: 'AVAILABLE', value };
}
