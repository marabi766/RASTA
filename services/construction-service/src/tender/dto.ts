import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { TENDER_STATES } from './tender.state-machine';

/**
 * The request and response shapes of the tender aggregate, validated at the
 * boundary (AGENTS.md § 3, `docs/06` § 6.4). The OpenAPI document is generated
 * from these same schemas (`src/openapi/document.ts`).
 *
 * ## `.strict()` is a security control here
 *
 * The fields a client may **not** send decide the outcome of a tender:
 * `organizationId` (the owner is the caller's organization, never the body),
 * `status` (only lifecycle commands move it), `version` (a precondition, sent
 * as `expectedVersion`), and every `…By`/`…At` audit column (taken from the
 * request context and the database clock). `.strict()` turns each into a `400`.
 *
 * ## Where the fields come from
 *
 * `docs/03` names a tender's `procurementNature` and its document (scope,
 * specification, quantities, conditions, criteria). The product document is not
 * in the repository, so only the scope text, the nature, the visibility (Q-84)
 * and the bidding window are modelled here; evaluation criteria arrive with
 * publication (ADR-067). Each optional field is filled in before publishing —
 * the database refuses a published tender without them, never a default.
 */

const PROVISIONAL = 'Provisional field (docs/24 Q-84): taken from';

/** Why, stated for somebody reading the record months later (S-06). */
const statedReason = z.string().trim().min(8).max(500);

/** The compare-and-set precondition every change carries (ADR-063, ADR-065). */
const expectedVersion = z.number().int().min(1).max(2_147_483_647);

export const PROCUREMENT_NATURES = ['FORMAL_TENDER', 'INQUIRY', 'RFP', 'MARKETPLACE_DEAL'] as const;
export const TENDER_VISIBILITIES = ['PUBLIC', 'RESTRICTED'] as const;

const title = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .describe(`${PROVISIONAL} docs/03 «مناقصه»: what is being tendered, in a line.`);
const scopeOfWork = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .describe(`${PROVISIONAL} docs/03 «سند مناقصه» (scope of work), as text; attachments are Q-86.`);
const procurementNature = z
  .enum(PROCUREMENT_NATURES)
  .describe(
    'docs/24 Q-03: chosen by the owner, never defaulted, and required before publishing. ' +
      'The platform draws no legal conclusion from it.',
  );
const visibility = z
  .enum(TENDER_VISIBILITIES)
  .describe(
    'docs/24 Q-84 (2): PUBLIC, or RESTRICTED to invited organizations. Required before publishing.',
  );

/**
 * A UTC instant with an explicit `Z` (ADR-065 § 2). An offset is refused rather
 * than converted: a deadline that can be written two ways is a deadline two
 * people can read differently.
 */
const utcInstant = z
  .string()
  .datetime({ message: 'A time is ISO 8601 in UTC with a trailing Z, e.g. 2026-10-31T12:00:00Z' });

const window = {
  bidOpeningAt: utcInstant.describe('Start of the bidding window, inclusive. UTC.'),
  bidClosingAt: utcInstant.describe(
    'End of the bidding window, exclusive: a bid received at this instant is refused. UTC.',
  ),
};

const windowIsOrdered = (value: { bidOpeningAt?: string | null; bidClosingAt?: string | null }) =>
  !value.bidOpeningAt ||
  !value.bidClosingAt ||
  Date.parse(value.bidOpeningAt) < Date.parse(value.bidClosingAt);

const windowIsWhole = (value: { bidOpeningAt?: string | null; bidClosingAt?: string | null }) =>
  (value.bidOpeningAt === undefined) === (value.bidClosingAt === undefined);

const WINDOW_ORDERED = { message: 'bidOpeningAt must be before bidClosingAt' };
const WINDOW_WHOLE = { message: 'bidOpeningAt and bidClosingAt are given together or not at all' };

export const createTenderSchema = z
  .object({
    title,
    scopeOfWork,
    procurementNature: procurementNature.optional(),
    visibility: visibility.optional(),
    bidOpeningAt: window.bidOpeningAt.optional(),
    bidClosingAt: window.bidClosingAt.optional(),
  })
  .strict()
  .refine(windowIsWhole, WINDOW_WHOLE)
  .refine(windowIsOrdered, WINDOW_ORDERED);

export type CreateTenderDto = z.infer<typeof createTenderSchema>;

/**
 * UpdateTender. Every field optional, at least one present; `null` clears the
 * nature, the visibility, or (both together) the window. Allowed only in DRAFT.
 */
export const updateTenderSchema = z
  .object({
    expectedVersion,
    title: title.optional(),
    scopeOfWork: scopeOfWork.optional(),
    procurementNature: procurementNature.nullable().optional(),
    visibility: visibility.nullable().optional(),
    bidOpeningAt: window.bidOpeningAt.nullable().optional(),
    bidClosingAt: window.bidClosingAt.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), {
    message: 'An update must change at least one field',
  })
  .refine(windowIsWhole, WINDOW_WHOLE)
  .refine((value) => (value.bidOpeningAt === null) === (value.bidClosingAt === null), {
    message: 'bidOpeningAt and bidClosingAt are cleared together or not at all',
  })
  .refine(windowIsOrdered, WINDOW_ORDERED);

export type UpdateTenderDto = z.infer<typeof updateTenderSchema>;

/** Cancelling a DRAFT is the only cancellation PR 2 offers; later steps widen the source states. */
export const cancelTenderSchema = z
  .object({
    expectedVersion,
    reason: statedReason,
  })
  .strict();

export type CancelTenderDto = z.infer<typeof cancelTenderSchema>;

export const listTendersQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(TENDER_STATES).optional(),
    projectId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type ListTendersQuery = z.infer<typeof listTendersQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes — one definition for the service's return types and for the
// published contract.
// ---------------------------------------------------------------------------

export const tenderViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    projectId: z.string(),
    title: z.string(),
    scopeOfWork: z.string(),
    procurementNature: z.enum(PROCUREMENT_NATURES).nullable(),
    visibility: z.enum(TENDER_VISIBILITIES).nullable(),
    bidOpeningAt: z.string().nullable(),
    bidClosingAt: z.string().nullable(),
    status: z.enum(TENDER_STATES),
    statusReason: z.string().nullable(),
    statusReasonCode: z.string().nullable(),
    statusChangedAt: z.string(),
    statusChangedBy: z.string(),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
    /** Send it back as `expectedVersion` with the next change. */
    version: z.number().int(),
  })
  .strict();

/** A listing omits the scope prose. */
export const tenderSummaryViewSchema = tenderViewSchema.omit({ scopeOfWork: true }).strict();

export type TenderView = z.infer<typeof tenderViewSchema>;
export type TenderSummaryView = z.infer<typeof tenderSummaryViewSchema>;
