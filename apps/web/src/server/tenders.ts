import { z } from 'zod';

import type { TenderStatus } from '@/lib/tender-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

export type { ReadResult };

/**
 * Reading tenders through the gateway (EXP-004 slice 2).
 *
 * Read-only: no command is issued from this module, so there is no
 * Idempotency-Key here. Two sides, each its own gateway door and each decided by
 * construction-service, never by the portal:
 *
 * - **The owner's side** — `GET /v1/tenders`, `/v1/tenders/{id}` and
 *   `/v1/tenders/{id}/criteria`: the tenders of the organization the request acts
 *   for. Another organization's tender answers 404, so it is rendered as absent.
 * - **The bidder's side** — `GET /v1/open-tenders` and `/v1/open-tenders/{id}`
 *   (CON-002 PR 6): the published tenders the caller's organization may bid on,
 *   public or invited, never its own.
 *
 * ## What is never read
 *
 * No route under `/v1/tenders/{id}/bids` (a bid, its receipt, the bid access log)
 * or `…/evaluation`, `…/award`, `…/invitations`, `…/approvals` is called: a
 * sealed bid, a bidder's identity or a count of bids is not something this slice
 * renders (ADR-066). Neither view the service returns for these two doors
 * carries one, and the schemas below would drop it if it did.
 *
 * ## What is kept
 *
 * Only what a screen renders. The actor ids (`createdBy`, `statusChangedBy`, …),
 * the owner's `organizationId` and the optimistic-lock `version` are dropped: a
 * React tree is serialized into the page, and a value nobody reads should not
 * travel with it. Every rendered timestamp is a valid UTC instant
 * (`instant.ts`): a malformed one is a `MALFORMED` outcome, not a render-time
 * exception.
 */

/** What an owner's list row renders and nothing more. */
const tenderSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  procurementNature: z.string().nullable().default(null),
  visibility: z.string().nullable().default(null),
  bidOpeningAt: utcInstant.nullable().default(null),
  bidClosingAt: utcInstant.nullable().default(null),
  status: z.string(),
  statusChangedAt: utcInstant,
});

export type TenderSummary = z.infer<typeof tenderSummarySchema>;

const tenderDetailSchema = tenderSummarySchema.extend({
  projectId: z.string(),
  scopeOfWork: z.string().default(''),
  statusReason: z.string().nullable().default(null),
  statusReasonCode: z.string().nullable().default(null),
  publishedAt: utcInstant.nullable().default(null),
  createdAt: utcInstant,
});

export type TenderDetail = z.infer<typeof tenderDetailSchema>;

const tenderPageSchema = z.object({
  items: z.array(tenderSummarySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type TenderPage = z.infer<typeof tenderPageSchema>;

const criterionSchema = z.object({
  code: z.string(),
  label: z.string(),
  weightBp: z.number().int(),
  scoringMethod: z.string(),
  maxScore: z.number().int(),
});

export type TenderCriterion = z.infer<typeof criterionSchema>;

/** The owner's view of a tender's criteria. */
const tenderCriteriaSchema = z.object({
  items: z.array(criterionSchema),
  totalWeightBp: z.number().int(),
  complete: z.boolean().default(false),
});

export type TenderCriteria = z.infer<typeof tenderCriteriaSchema>;

/**
 * A published tender as a bidder sees it. The window is required here: the
 * service answers `''` for a tender without one, and a published tender always
 * has one, so an empty value is a malformed answer, not an open-ended tender.
 */
const openTenderSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  procurementNature: z.string().nullable().default(null),
  visibility: z.string(),
  bidOpeningAt: utcInstant,
  bidClosingAt: utcInstant,
});

export type OpenTenderSummary = z.infer<typeof openTenderSummarySchema>;

const openTenderDetailSchema = openTenderSummarySchema.extend({
  scopeOfWork: z.string().default(''),
  criteria: z.array(criterionSchema),
});

export type OpenTenderDetail = z.infer<typeof openTenderDetailSchema>;

const openTenderPageSchema = z.object({
  items: z.array(openTenderSummarySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type OpenTenderPage = z.infer<typeof openTenderPageSchema>;

export const TENDERS_PER_PAGE = 20;

export interface TenderListQuery {
  readonly status?: TenderStatus;
  readonly cursor?: string;
}

export interface OpenTenderListQuery {
  readonly cursor?: string;
}

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      // construction-service answers 404, never 403, for a tender the caller may
      // not see, so its existence is not disclosed. It is rendered as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchTenders(
  session: WebSession,
  query: TenderListQuery = {},
): Promise<ReadResult<TenderPage>> {
  const search = new URLSearchParams({ limit: String(TENDERS_PER_PAGE) });
  if (query.status) search.set('status', query.status);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/tenders?${search.toString()}`, tenderPageSchema);
}

export function fetchTender(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<TenderDetail>> {
  return read(session, `/v1/tenders/${encodeURIComponent(tenderId)}`, tenderDetailSchema);
}

export function fetchTenderCriteria(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<TenderCriteria>> {
  return read(
    session,
    `/v1/tenders/${encodeURIComponent(tenderId)}/criteria`,
    tenderCriteriaSchema,
  );
}

export function fetchOpenTenders(
  session: WebSession,
  query: OpenTenderListQuery = {},
): Promise<ReadResult<OpenTenderPage>> {
  const search = new URLSearchParams({ limit: String(TENDERS_PER_PAGE) });
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/open-tenders?${search.toString()}`, openTenderPageSchema);
}

export function fetchOpenTender(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<OpenTenderDetail>> {
  return read(session, `/v1/open-tenders/${encodeURIComponent(tenderId)}`, openTenderDetailSchema);
}
