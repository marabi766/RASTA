import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';

/**
 * The request and response shapes of the fleet dashboard (ADR-071 § 4, RUN-001 PR 1).
 *
 * The same Zod schemas validate input, type the code and — through `toJsonSchema` — become
 * the OpenAPI document, so the three cannot disagree. No body anywhere: this service has no
 * route that writes.
 */

const instant = z.string().check(isoDateTime({ offset: true }));

/**
 * The window, `[from, to)`, both required: a default window would be a number nobody chose
 * (AGENTS.md § 8), and a caller always knows what period it is asking about. Unknown
 * parameters are refused rather than ignored.
 */
export const fleetDashboardQuerySchema = z
  .object({
    from: instant.describe('Start of the window, inclusive (ISO 8601 with offset).'),
    to: instant.describe('End of the window, exclusive (ISO 8601 with offset).'),
  })
  .strict()
  .refine((query) => Date.parse(query.from) < Date.parse(query.to), {
    message: 'from must be before to',
    path: ['from'],
  });

export type FleetDashboardQuery = z.infer<typeof fleetDashboardQuerySchema>;

const amountSchema = z
  .object({
    currency: z.string().describe('ISO 4217, as the producer stated it.'),
    amountMinor: z
      .string()
      .regex(/^\d+$/)
      .describe(
        'The sum in minor units (rials for IRR), a decimal string; never a float. Exact, and ' +
          'may exceed a 64-bit integer: each cost fits a bigint, their sum need not.',
      ),
  })
  .strict();

const completedByTypeSchema = z
  .object({
    type: z
      .string()
      .describe(
        'The maintenance type as maintenance-service publishes it (PREVENTIVE, CORRECTIVE today). ' +
          'A type the producer adds appears under its own name.',
      ),
    count: z.number().int().describe('Completions of this type in the window.'),
    downtime: z
      .object({
        knownCount: z
          .number()
          .int()
          .describe(
            'Completions whose downtime the producer knew. The others are not counted as zero.',
          ),
        totalMinutes: z
          .string()
          .regex(/^\d+$/)
          .describe(
            'Summed over those completions only; a decimal string, exact however large the sum.',
          ),
      })
      .strict(),
    cost: z
      .array(amountSchema)
      .describe('Summed per currency, never across two; ordered by currency.'),
  })
  .strict();

export const fleetDashboardViewSchema = z
  .object({
    organizationId: z.string().describe('The organization the dashboard is for: the request’s.'),
    from: z.string(),
    to: z.string(),
    earliestCompletionAt: z
      .string()
      .nullable()
      .describe(
        'The earliest completion this service holds a fact for, in any window — or null when it ' +
          'holds none. Facts exist only from the events it has received (domain topics keep seven ' +
          'days), so before this instant an empty window means "not known here", not "none".',
      ),
    maintenance: z
      .object({
        completed: z
          .array(completedByTypeSchema)
          .describe('Completed maintenance in the window, by type, ordered by type. No ratio.'),
      })
      .strict(),
  })
  .strict();

export type FleetDashboardView = z.infer<typeof fleetDashboardViewSchema>;
