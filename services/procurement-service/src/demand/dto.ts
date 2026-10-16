import { z } from 'zod';
import { cursorPaginationSchema, plainText } from '@rasta/contracts';
import { SHORTFALL_POLICIES } from '../config/env';
import { AGGREGATION_STATES, DEMAND_STATES } from './demand.state-machine';

/**
 * The request and response shapes of the demand and aggregation API (ADR-070 § 2; the planned
 * contract `docs/api/procurement-service.planned.openapi.json`, operations of PR 1).
 *
 * The same Zod schemas validate input, type the code and — through `zod-schema.ts` — become the
 * OpenAPI document, so the three cannot disagree. Every command takes a strict body: nothing in it
 * decides who acts, for which organization, or when.
 */

/** Marketplace's opaque product identifier; never checked there (Q-105, Q-120). */
export const PRODUCT_ID_PATTERN = /^PRD_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The largest quantity anything holds — one demand, and the total of a window (ADR-070 § 2): a
 * PostgreSQL integer, the `int32` of the published schemas. The RFQ and the purchase order a window
 * becomes carry that total as their quantity, so it stays representable all the way. A
 * representation limit, not a business rule.
 */
export const MAX_QUANTITY = 2_147_483_647;

export const MAX_NOTE_LENGTH = 500;
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 500;

/** `POST /v1/demand-requests`: a need of the caller's organization. */
export const submitDemandSchema = z
  .object({
    productId: z
      .string()
      .regex(PRODUCT_ID_PATTERN)
      .describe(
        'Marketplace’s product identifier, `PRD_<ULID>`. Opaque: never checked against ' +
          'marketplace (Q-105, Q-120).',
      ),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUANTITY)
      .describe('Whole units of the product’s base unit (Q-105).'),
    note: plainText()
      .min(1)
      .max(MAX_NOTE_LENGTH)
      .optional()
      .describe(
        'Optional free text, trimmed, up to 500 characters, without bidirectional control ' +
          'characters. Read through this API by the buyer only; never on an event.',
      ),
  })
  .strict();
export type SubmitDemandDto = z.infer<typeof submitDemandSchema>;

/** `POST /v1/demand-requests/{id}/withdraw`: the reason is required; there is no edit. */
export const withdrawDemandSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe(
        'The `version` the caller read: the withdrawal applies only to that version ' +
          '(409 OPTIMISTIC_LOCK_FAILED otherwise).',
      ),
    reason: plainText()
      .min(MIN_REASON_LENGTH)
      .max(MAX_REASON_LENGTH)
      .describe(
        'Why, 8 to 500 characters, trimmed, without bidirectional control characters. Kept with ' +
          'the demand and read through this API; never on an event.',
      ),
  })
  .strict();
export type WithdrawDemandDto = z.infer<typeof withdrawDemandSchema>;

export const listDemandsQuerySchema = cursorPaginationSchema
  .extend({ status: z.enum(DEMAND_STATES).optional() })
  .strict();
export type ListDemandsQuery = z.infer<typeof listDemandsQuerySchema>;

export const listAggregationsQuerySchema = cursorPaginationSchema
  .extend({ status: z.enum(AGGREGATION_STATES).optional() })
  .strict();
export type ListAggregationsQuery = z.infer<typeof listAggregationsQuerySchema>;

const utcInstant = (what: string) => z.string().describe(`${what} (UTC, ISO 8601 with Z).`);

/** A demand as its own organization reads it. */
export const demandViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The buyer: the organization that registered it.'),
    productId: z.string(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    status: z.enum(DEMAND_STATES),
    aggregationId: z.string().describe('The window it joined.'),
    note: z.string().nullable(),
    submittedAt: utcInstant('When it was registered, by the database clock'),
    withdrawnAt: z.string().nullable().describe('When it was withdrawn, or null.'),
    withdrawReason: z.string().nullable().describe('Why it was withdrawn, or null.'),
    version: z.number().int(),
  })
  .strict();
export type DemandView = z.infer<typeof demandViewSchema>;

/** The settings a window opened with — never the configuration of today (docs/08 § 8.9). */
export const settingSnapshotSchema = z
  .object({
    windowHours: z.number().int().min(1),
    minQuantity: z.number().int().min(0).describe('A quantity, not an amount (Q-10).'),
    shortfallPolicy: z.enum(SHORTFALL_POLICIES),
    settingVersion: z.number().int().nullable().describe('null = the environment defaults (Q-10).'),
  })
  .strict();

/** An aggregation as its own organization reads it. */
export const aggregationViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The buyer.'),
    productId: z.string(),
    status: z.enum(AGGREGATION_STATES),
    openedAt: utcInstant('When its first demand opened the window'),
    closesAt: utcInstant('When the window ends, exclusive: a demand at or after it never joins'),
    totalQuantity: z
      .number()
      .int()
      .min(0)
      .max(MAX_QUANTITY)
      .describe(
        'The sum of the quantities of the demands it holds (withdrawn ones excluded); frozen once ' +
          'the window ended. Never above MAX_QUANTITY: a demand that would take it past is 422 ' +
          'AGGREGATION_QUANTITY_LIMIT_EXCEEDED (ADR-070 § 2).',
      ),
    demandCount: z.number().int(),
    extensionCount: z.number().int(),
    setting: settingSnapshotSchema,
    closedAt: z.string().nullable().describe('When the window ended, or null while OPEN.'),
    rfqId: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();
export type AggregationView = z.infer<typeof aggregationViewSchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
