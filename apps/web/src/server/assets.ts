import { z } from 'zod';
import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';

/**
 * Reading assets through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * The schemas below mirror asset-service's views and keep **only what a screen
 * renders**. Zod drops everything else, which is the point: the dossier
 * response carries coordinates, document references and raw specification
 * blobs, and a field that never enters this process cannot be leaked by a
 * template, serialized into the page for hydration, or accidentally logged.
 *
 * Nothing here decides anything. Whether this person may see this asset is
 * settled by the gateway and by asset-service, per request, and a 403 arrives
 * here as an outcome to render rather than a rule to re-implement
 * (`docs/16 § ۱۶٫۱۱`: hiding a control is not a security control).
 */

export const ASSET_STATUSES = [
  'REGISTERED',
  'ACTIVE',
  'ASSIGNED',
  'IDLE',
  'IN_MAINTENANCE',
  'OUT_OF_SERVICE',
  'DECOMMISSIONED',
] as const;

export const ASSET_TYPES = [
  'HEAVY_MACHINERY',
  'LIGHT_VEHICLE',
  'WASTE_COLLECTOR',
  'EMERGENCY_VEHICLE',
  'PASSENGER_VEHICLE',
  'FIXED_EQUIPMENT',
  'OTHER',
] as const;

/**
 * The status and type vocabularies are `catch`-free on purpose.
 *
 * A value this portal does not know means asset-service has moved ahead of it.
 * Rendering it plainly is better than refusing the whole page, so the schema
 * accepts any string and the label functions fall back to the raw value —
 * visible, unmistakable, and impossible to confuse with a translated label.
 */
const assetSchema = z.object({
  id: z.string(),
  assetTag: z.string().nullable().default(null),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  manufacturer: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  manufactureYear: z.number().int().nullable().default(null),
  commissionedAt: z.string().nullable().default(null),
});

export type AssetSummary = z.infer<typeof assetSchema>;

const assetPageSchema = z.object({
  items: z.array(assetSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type AssetPage = z.infer<typeof assetPageSchema>;

const complianceSchema = z.object({
  operable: z.boolean(),
  /** Every reason this asset cannot be dispatched, not only the first. */
  blockers: z.array(z.string()).default([]),
  activeInsurance: z
    .object({
      policyNumber: z.string(),
      insurerName: z.string(),
      validTo: z.string(),
      daysUntilExpiry: z.number().int(),
    })
    .nullable()
    .default(null),
  latestInspection: z
    .object({
      certificateNo: z.string().nullable().default(null),
      centerName: z.string().nullable().default(null),
      validTo: z.string(),
      result: z.string(),
      daysUntilExpiry: z.number().int(),
    })
    .nullable()
    .default(null),
});

const timelineEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  /** Minor units as a string — a rial total does not survive a JSON number. */
  amountMinor: z.string().nullable().default(null),
  occurredAt: z.string(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

const dossierSchema = z.object({
  asset: assetSchema,
  organizationName: z.string().nullable().default(null),
  compliance: complianceSchema,
  costs: z.object({
    totalMinor: z.string(),
    maintenanceMinor: z.string(),
    partsAndOrdersMinor: z.string(),
    entryCount: z.number().int(),
  }),
  recentActivity: z.array(timelineEntrySchema).default([]),
  transferCount: z.number().int().default(0),
});

export type AssetDossier = z.infer<typeof dossierSchema>;

/**
 * Every way a read can end, as something a screen can render.
 *
 * `FORBIDDEN` and `NOT_FOUND` are kept apart from a general failure because
 * they are different sentences to a person: one says "this is not yours", the
 * other says "this is not here". Folding them into one error state would make
 * the screen tell somebody the wrong thing about their own permissions.
 */
export type ReadResult<T> =
  | { readonly kind: 'OK'; readonly data: T }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly status: number; readonly correlationId: string }
  | { readonly kind: 'MALFORMED'; readonly correlationId: string };

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  // The schema itself rather than its output type: several fields here carry
  // a `.default()`, so the parsed value is narrower than what Zod accepts, and
  // a `ZodType<T>` parameter would make the two disagree at every call site.
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

export interface AssetListQuery {
  readonly status?: string;
  readonly type?: string;
  readonly q?: string;
  readonly cursor?: string;
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const ASSETS_PER_PAGE = 20;

export function fetchAssets(
  session: WebSession,
  query: AssetListQuery = {},
): Promise<ReadResult<AssetPage>> {
  const params = new URLSearchParams({ limit: String(ASSETS_PER_PAGE) });
  // Only what the caller actually set. An empty `q=` is a filter the service
  // would refuse, and a filter nobody asked for.
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);

  return read(session, `/v1/assets?${params.toString()}`, assetPageSchema);
}

export function fetchDossier(
  session: WebSession,
  assetId: string,
): Promise<ReadResult<AssetDossier>> {
  // The id goes in a path segment, so it is encoded rather than interpolated:
  // an id containing a slash would otherwise address a different endpoint.
  return read(session, `/v1/assets/${encodeURIComponent(assetId)}/dossier`, dossierSchema);
}

const timelinePageSchema = z.object({
  items: z.array(timelineEntrySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type AssetTimelinePage = z.infer<typeof timelinePageSchema>;

export interface AssetTimelineQuery {
  readonly category?: string;
  readonly cursor?: string;
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const ASSET_TIMELINE_PER_PAGE = 20;

export function fetchAssetTimeline(
  session: WebSession,
  assetId: string,
  query: AssetTimelineQuery = {},
): Promise<ReadResult<AssetTimelinePage>> {
  const params = new URLSearchParams({ limit: String(ASSET_TIMELINE_PER_PAGE) });
  // Only what the caller actually set — `category` is a strict enum on
  // asset-service's side, and an empty value would be refused rather than
  // read as "no filter".
  if (query.category) params.set('category', query.category);
  if (query.cursor) params.set('cursor', query.cursor);

  return read(
    session,
    `/v1/assets/${encodeURIComponent(assetId)}/timeline?${params.toString()}`,
    timelinePageSchema,
  );
}
