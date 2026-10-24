import { z } from 'zod';
import { fleetDashboardQuerySchema } from '../maintenance/dto';
import { KPI_DEFINITIONS } from './definitions';

// Exactly PR 1's explicit [from, to) window and strict rejection of unknown parameters.
export const kpisQuerySchema = fleetDashboardQuerySchema;
export type KpisQuery = z.infer<typeof kpisQuerySchema>;

export const kpiStatusSchema = z.enum(['AVAILABLE', 'INSUFFICIENT_BASELINE']);
export const kpiValueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('AVAILABLE'), value: z.string().regex(/^\d+$/) }).strict(),
  z.object({ status: z.literal('INSUFFICIENT_BASELINE'), value: z.literal(null) }).strict(),
]);
export type KpiValue = z.infer<typeof kpiValueSchema>;

const kpiMetadata = z
  .object({
    key: z.enum([KPI_DEFINITIONS[0].key, KPI_DEFINITIONS[1].key]),
    unit: z.enum(['COUNT', 'MINUTES']),
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
          'A zero count describes only the events this service received, not historical coverage.',
      ),
    kpis: z.array(kpiSchema),
  })
  .strict();
export type KpisView = z.infer<typeof kpisViewSchema>;

export function baselineValue(value: string | null): KpiValue {
  return value === null
    ? { status: 'INSUFFICIENT_BASELINE', value: null }
    : { status: 'AVAILABLE', value };
}
