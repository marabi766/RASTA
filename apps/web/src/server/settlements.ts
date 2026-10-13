import { z } from 'zod';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import type { SettlementView } from '@/lib/settlement-fields';

export type { ReadResult };

/**
 * Reading settlements through the gateway (`GET /v1/settlements`, `/:id`).
 *
 * Read-only: a settlement is made by `POST /v1/settlements`, which only
 * marketplace-service and contract-service may call, so this portal has
 * nothing to write.
 *
 * ## Money
 *
 * Amounts stay strings end to end (ADR-022), exactly as `orders.ts`: checked
 * to be whole minor units and never turned into a `number`.
 *
 * ## Paging
 *
 * The list answers `{ items }` with no `nextCursor`, and its cursor is the id
 * of the last row already seen. A page is therefore asked for with one row
 * more than it shows: the extra row proves there is more, and the last row
 * shown is the cursor. Guessing from a full page instead would offer a "next
 * page" that is empty whenever the total is a multiple of the page size.
 */

const minorUnits = z.string().regex(/^-?\d+$/, 'amount must be whole minor units');

/**
 * `settledBy` (a user id) is on the detail response and not declared, so Zod
 * drops it: nothing renders it, and a React tree is serialized into the page.
 */
const settlementSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  journalId: z.string(),
  payerOrganizationId: z.string(),
  payeeOrganizationId: z.string(),
  grossAmountMinor: minorUnits,
  commissionAmountMinor: minorUnits,
  netAmountMinor: minorUnits,
  currency: z.string(),
  settledAt: z.string(),
});

export type Settlement = z.infer<typeof settlementSchema>;

const settlementItemsSchema = z.object({ items: z.array(settlementSchema) });

export interface SettlementPage {
  readonly items: readonly Settlement[];
  readonly nextCursor: string | null;
}

export const SETTLEMENTS_PER_PAGE = 20;

export interface SettlementListQuery {
  readonly view: SettlementView;
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
      // economic-service answers 404, never 403, for a settlement the caller
      // was not party to, so the screen renders it as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export async function fetchSettlements(
  session: WebSession,
  query: SettlementListQuery,
): Promise<ReadResult<SettlementPage>> {
  const search = new URLSearchParams({
    limit: String(SETTLEMENTS_PER_PAGE + 1),
    incoming: query.view === 'RECEIVED' ? 'true' : 'false',
  });
  if (query.cursor) search.set('cursor', query.cursor);

  const result = await read(session, `/v1/settlements?${search.toString()}`, settlementItemsSchema);
  if (result.kind !== 'OK') return result;

  const rows = result.data.items;
  const items = rows.slice(0, SETTLEMENTS_PER_PAGE);
  const last = items[items.length - 1];
  const hasMore = rows.length > SETTLEMENTS_PER_PAGE;
  return { kind: 'OK', data: { items, nextCursor: hasMore && last ? last.id : null } };
}

export function fetchSettlement(
  session: WebSession,
  settlementId: string,
): Promise<ReadResult<Settlement>> {
  return read(session, `/v1/settlements/${encodeURIComponent(settlementId)}`, settlementSchema);
}
