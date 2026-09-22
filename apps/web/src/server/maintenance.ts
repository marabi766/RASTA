import { z } from 'zod';
import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

/**
 * Reading maintenance requests through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * Same shape as `assets.ts`, deliberately: the schemas below keep **only what
 * a screen renders**, so a field that never enters this process cannot be
 * leaked by a template or accidentally logged. Nothing here decides anything
 * — a 403 or a 404 arrives as an outcome to render, not a rule to
 * re-implement (`docs/16 § ۱۶٫۱۱`).
 */

/**
 * Both vocabularies are `catch`-free, matching `assets.ts`.
 *
 * A status or type this portal does not know means maintenance-service has
 * moved ahead of it. Rendering it plainly is better than refusing the whole
 * page.
 */
const requestSummarySchema = z.object({
  id: z.string(),
  assetId: z.string(),
  scheduleId: z.string().nullable().default(null),
  type: z.string(),
  status: z.string(),
  severity: z.string().nullable().default(null),
  title: z.string(),
  reportedAt: z.string(),
  dueDate: z.string().nullable().default(null),
  totalCostMinor: z.string(),
});

export type MaintenanceRequestSummary = z.infer<typeof requestSummarySchema>;

const requestPageSchema = z.object({
  items: z.array(requestSummarySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type MaintenanceRequestPage = z.infer<typeof requestPageSchema>;

/** One line of the request's cost, by category. */
const costLineSchema = z.object({
  category: z.string(),
  amountMinor: z.string(),
});

/**
 * A repair order as it appears embedded in a request's detail — the summary
 * view maintenance-service's own detail endpoint returns, not the fuller
 * `RepairOrderDetailView` behind `GET /v1/repair-orders/{id}` (which adds
 * parts, labour and cost lines this screen has no need to show).
 */
const repairOrderSchema = z.object({
  id: z.string(),
  status: z.string(),
  workshopName: z.string().nullable().default(null),
  workSummary: z.string().nullable().default(null),
  workPerformed: z.string().nullable().default(null),
  assignedAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  cancelledAt: z.string().nullable().default(null),
  cancellationReason: z.string().nullable().default(null),
  partsCostMinor: z.string(),
  labourCostMinor: z.string(),
  otherCostMinor: z.string(),
  totalCostMinor: z.string(),
});

export type RepairOrderSummary = z.infer<typeof repairOrderSchema>;

const requestDetailSchema = requestSummarySchema.extend({
  description: z.string().nullable().default(null),
  reportedBy: z.string(),
  outOfServiceAt: z.string().nullable().default(null),
  returnedToServiceAt: z.string().nullable().default(null),
  downtimeMinutes: z.number().int().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  approvalNotes: z.string().nullable().default(null),
  cancelledAt: z.string().nullable().default(null),
  cancellationReason: z.string().nullable().default(null),
  repairOrders: z.array(repairOrderSchema).default([]),
  costBreakdown: z.array(costLineSchema).default([]),
});

export type MaintenanceRequestDetail = z.infer<typeof requestDetailSchema>;

// Re-exported so a screen needs one import for both this module's results and
// `assets.ts`'s — the shape is identical, and only one module should define it.
export type { ReadResult };

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
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export interface MaintenanceRequestListQuery {
  readonly status?: string;
  readonly type?: string;
  readonly severity?: string;
  readonly cursor?: string;
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const MAINTENANCE_REQUESTS_PER_PAGE = 20;

export function fetchMaintenanceRequests(
  session: WebSession,
  query: MaintenanceRequestListQuery = {},
): Promise<ReadResult<MaintenanceRequestPage>> {
  const params = new URLSearchParams({ limit: String(MAINTENANCE_REQUESTS_PER_PAGE) });
  // Only what the caller actually set — an empty filter is a filter nobody
  // asked for, and `status`/`type`/`severity` are each a strict enum the
  // service would refuse an empty value for.
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.severity) params.set('severity', query.severity);
  if (query.cursor) params.set('cursor', query.cursor);

  return read(session, `/v1/maintenance-requests?${params.toString()}`, requestPageSchema);
}

export function fetchMaintenanceRequest(
  session: WebSession,
  requestId: string,
): Promise<ReadResult<MaintenanceRequestDetail>> {
  // The id goes in a path segment, so it is encoded rather than interpolated:
  // an id containing a slash would otherwise address a different endpoint.
  return read(
    session,
    `/v1/maintenance-requests/${encodeURIComponent(requestId)}`,
    requestDetailSchema,
  );
}
