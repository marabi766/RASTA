import { z } from 'zod';

import type { ReadResult } from './assets';
import { webServerEnv } from './env';
import { callGateway, GatewayRequestError } from './gateway';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import { actingOrganizationId, tenantCredential } from './session-organization';

export type { ReadResult };

/**
 * Reading demands and the aggregation each joined, through the gateway
 * (EXP-004, COM-007; procurement-service `demand/demand.controller.ts`).
 * Read-only: the submission is `demand-commands.ts`.
 *
 * ## Whose demands
 *
 * The buyer's own organization only: procurement-service answers `404`, never
 * `403`, for another organization's demand or aggregation, and `403` before
 * reading anything for a role it does not grant (`AUDITOR`, `SYSTEM_ADMIN`
 * included). This module adds the portal's own wall behind it, failing closed:
 * a demand or aggregation whose `organizationId` is not the organization this
 * session acts for is **never rendered** — one record is answered as absent,
 * exactly like an id that does not exist, and a list page holding one is
 * refused whole (`MALFORMED`) rather than filtered, so nothing of it is shown.
 *
 * ## Nothing required is defaulted
 *
 * Every field the service's `demandViewSchema` / `aggregationViewSchema` mark
 * required is required here, nullable ones included: a missing `withdrawnAt`
 * would read as "never withdrawn", a missing `nextCursor` as the end of the list.
 */

const demandSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  productId: z.string(),
  quantity: z.number().int().min(1),
  /** Not narrowed to the known four: an unknown status is shown by its code (`labels.ts`). */
  status: z.string(),
  aggregationId: z.string().min(1),
  note: z.string().nullable(),
  submittedAt: utcInstant,
  withdrawnAt: utcInstant.nullable(),
  withdrawReason: z.string().nullable(),
  version: z.number().int().min(1),
});
export type DemandRecord = z.infer<typeof demandSchema>;

const demandPageSchema = z.object({
  items: z.array(demandSchema),
  nextCursor: z.string().min(1).nullable(),
});

const aggregationSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  productId: z.string(),
  status: z.string(),
  openedAt: utcInstant,
  closesAt: utcInstant,
  totalQuantity: z.number().int().min(0),
  demandCount: z.number().int().min(0),
  extensionCount: z.number().int().min(0),
  setting: z.object({
    windowHours: z.number().int(),
    minQuantity: z.number().int(),
    shortfallPolicy: z.string(),
    settingVersion: z.number().int().nullable(),
  }),
  closedAt: utcInstant.nullable(),
  cancelledAt: utcInstant.nullable(),
  cancelReason: z.string().nullable(),
  rfqId: z.string().nullable(),
  version: z.number().int().min(1),
});
export type AggregationRecord = z.infer<typeof aggregationSchema>;

export const DEMANDS_PER_PAGE = 20;

/**
 * The most pages one render follows past an **empty** page that still has a
 * `nextCursor` (checklist D 8): an empty page is not proof that nothing follows.
 * Running out of pages is "more may exist" (`nextCursor` kept), never "none".
 */
export const DEMAND_LIST_MAX_PAGES = 5;

export interface DemandListQuery {
  readonly status?: string;
  readonly cursor?: string;
}

export interface DemandPage {
  readonly items: readonly DemandRecord[];
  /** Where the next page starts; non-null with no items = more may exist, unread. */
  readonly nextCursor: string | null;
}

/**
 * One read, with the tenant wall applied before anything is returned: `owned`
 * must hold for the parsed answer, or the read ends as `foreign` — `NOT_FOUND`
 * for one record (absent and "not yours" read the same), `MALFORMED` for a page.
 */
async function readOwned<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
  owned: (data: z.infer<S>, organizationId: string) => boolean,
  foreign: 'NOT_FOUND' | 'MALFORMED',
): Promise<ReadResult<z.infer<S>>> {
  const organizationId = actingOrganizationId(session);
  // No organization to be the buyer: nothing of any buyer's is this session's.
  if (organizationId === null) return { kind: 'NOT_FOUND' };
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      credential: tenantCredential(session),
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    if (!owned(parsed.data, organizationId)) {
      return foreign === 'NOT_FOUND'
        ? { kind: 'NOT_FOUND' }
        : { kind: 'MALFORMED', correlationId: response.correlationId };
    }
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export async function fetchDemands(
  session: WebSession,
  query: DemandListQuery = {},
): Promise<ReadResult<DemandPage>> {
  let cursor = query.cursor ?? null;
  for (let page = 1; ; page += 1) {
    const search = new URLSearchParams({ limit: String(DEMANDS_PER_PAGE) });
    if (query.status) search.set('status', query.status);
    if (cursor) search.set('cursor', cursor);
    const result = await readOwned(
      session,
      `/v1/demand-requests?${search.toString()}`,
      demandPageSchema,
      // Another organization's row in this organization's list: show none of it.
      (data, organizationId) => data.items.every((item) => item.organizationId === organizationId),
      'MALFORMED',
    );
    if (result.kind !== 'OK') return result;
    const next = result.data.nextCursor;
    if (result.data.items.length > 0 || next === null || page >= DEMAND_LIST_MAX_PAGES) {
      return { kind: 'OK', data: { items: result.data.items, nextCursor: next } };
    }
    cursor = next;
  }
}

/** One demand; another organization's reads exactly as an id that does not exist. */
export function fetchDemand(
  session: WebSession,
  demandId: string,
): Promise<ReadResult<DemandRecord>> {
  return readOwned(
    session,
    `/v1/demand-requests/${encodeURIComponent(demandId)}`,
    demandSchema,
    (data, organizationId) => data.id === demandId && data.organizationId === organizationId,
    'NOT_FOUND',
  );
}

/**
 * The aggregation `demand` joined: the one it names, of this organization, or it
 * is answered as absent.
 */
export function fetchDemandAggregation(
  session: WebSession,
  demand: Pick<DemandRecord, 'aggregationId'>,
): Promise<ReadResult<AggregationRecord>> {
  return readOwned(
    session,
    `/v1/aggregations/${encodeURIComponent(demand.aggregationId)}`,
    aggregationSchema,
    (data, organizationId) =>
      data.id === demand.aggregationId && data.organizationId === organizationId,
    'NOT_FOUND',
  );
}
