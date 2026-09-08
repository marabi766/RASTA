import { z } from 'zod';
import { amountMinorSchema } from '@rasta/contracts';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * Assets and the electronic dossier, from `asset-service`.
 *
 * The dossier is the product document's central promise for fleet management:
 * one place that answers what this machine is, whether it may be dispatched
 * today, what it has cost, and what has happened to it. It is also the single
 * most useful thing to show, because it is assembled from facts four services
 * own and is the visible proof that the event architecture works.
 *
 * Two fields carry rules the UI must not soften:
 *
 *  - `compliance.blockers` is **every** reason a machine cannot be dispatched,
 *    not the first. The service returns all of them deliberately, so an
 *    operator fixing one does not have to re-check to discover the next; a UI
 *    that showed only the first would undo that.
 *  - `costs.*Minor` are accumulated rial strings. They stay strings.
 *
 * Shapes read from `services/asset-service/src/asset/dto.ts`.
 */

export const ASSET_ADAPTER = {
  id: 'asset.registry',
  service: 'asset-service',
  routes: [
    'GET /v1/assets',
    'GET /v1/assets/{id}',
    'GET /v1/assets/{id}/dossier',
    'GET /v1/assets/{id}/timeline',
  ],
} as const satisfies AdapterDescriptor;

export const ASSET_TYPES = [
  'GRADER',
  'LOADER',
  'EXCAVATOR',
  'BULLDOZER',
  'TRUCK',
  'LIGHT_TRUCK',
  'TRACTOR',
  'WATER_TANKER',
] as const;

export const OPERATIONAL_STATUSES = [
  'REGISTERED',
  'ACTIVE',
  'ASSIGNED',
  'IDLE',
  'IN_MAINTENANCE',
  'OUT_OF_SERVICE',
  'DECOMMISSIONED',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

/** Persian labels. The Latin enum travels alongside, never instead of it. */
export const ASSET_TYPE_LABELS: Record<string, string> = {
  GRADER: 'گریدر',
  LOADER: 'لودر',
  EXCAVATOR: 'بیل مکانیکی',
  BULLDOZER: 'بولدوزر',
  TRUCK: 'کامیون',
  LIGHT_TRUCK: 'کامیونت',
  TRACTOR: 'تراکتور',
  WATER_TANKER: 'تانکر آب',
};

export const OPERATIONAL_STATUS_LABELS: Record<string, string> = {
  REGISTERED: 'ثبت‌شده',
  ACTIVE: 'فعال',
  ASSIGNED: 'تخصیص‌یافته',
  IDLE: 'بیکار',
  IN_MAINTENANCE: 'در تعمیر',
  OUT_OF_SERVICE: 'خارج از سرویس',
  DECOMMISSIONED: 'از رده خارج',
};

export const assetViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  assetTag: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  manufactureYear: z.number().int().nullable(),
  status: z.string(),
  commissionedAt: z.string().nullable(),
  decommissionedAt: z.string().nullable(),
  specifications: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AssetView = z.infer<typeof assetViewSchema>;

const insurancePolicySchema = z.object({
  id: z.string(),
  policyNumber: z.string(),
  insurerName: z.string(),
  coverage: z.string(),
  premiumMinor: amountMinorSchema.nullable(),
  insuredValueMinor: amountMinorSchema.nullable(),
  validFrom: z.string(),
  validTo: z.string(),
  status: z.string(),
  /** Negative once lapsed, so "expired 3 days ago" is renderable. */
  daysUntilExpiry: z.number().int(),
});

const inspectionSchema = z.object({
  id: z.string(),
  certificateNo: z.string(),
  centerName: z.string().nullable(),
  inspectedAt: z.string(),
  validTo: z.string(),
  result: z.string(),
  notes: z.string().nullable(),
  daysUntilExpiry: z.number().int(),
});

export const timelineEntrySchema = z.object({
  id: z.string(),
  eventName: z.string(),
  sourceService: z.string(),
  category: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amountMinor: z.string().nullable(),
  detail: z.record(z.unknown()),
  occurredAt: z.string(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const assetDossierSchema = z.object({
  asset: assetViewSchema,
  organizationName: z.string().nullable(),
  currentLocation: z
    .object({
      id: z.string(),
      siteName: z.string().nullable(),
      addressLine: z.string().nullable(),
      coordinate: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
      source: z.string(),
      recordedAt: z.string(),
    })
    .nullable(),
  compliance: z.object({
    operable: z.boolean(),
    blockers: z.array(z.string()),
    activeInsurance: insurancePolicySchema.nullable(),
    latestInspection: inspectionSchema.nullable(),
  }),
  costs: z.object({
    totalMinor: amountMinorSchema,
    maintenanceMinor: amountMinorSchema,
    partsAndOrdersMinor: amountMinorSchema,
    entryCount: z.number().int(),
  }),
  documents: z.array(
    z.object({
      id: z.string(),
      documentId: z.string(),
      kind: z.string(),
      title: z.string(),
      issuedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
    }),
  ),
  recentActivity: z.array(timelineEntrySchema),
  transferCount: z.number().int(),
});

export type AssetDossier = z.infer<typeof assetDossierSchema>;

const assetPageSchema = z.object({
  items: z.array(assetViewSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const timelinePageSchema = z.object({
  items: z.array(timelineEntrySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export interface AssetQuery {
  readonly q?: string;
  readonly status?: OperationalStatus;
  readonly type?: AssetType;
  /** Assets whose insurance or inspection lapses within N days. */
  readonly expiringWithinDays?: number;
  readonly limit?: number;
}

export async function listAssets(
  client: ApiClient,
  query: AssetQuery = {},
  signal?: AbortSignal,
): Promise<AssetView[]> {
  const result = await client.request({
    path: '/v1/assets',
    schema: assetPageSchema,
    signal,
    query: {
      q: query.q?.trim() || undefined,
      status: query.status,
      type: query.type,
      expiringWithinDays: query.expiringWithinDays,
      limit: query.limit ?? 50,
    },
  });

  return result.data.items;
}

export async function fetchDossier(
  client: ApiClient,
  assetId: string,
  signal?: AbortSignal,
): Promise<AssetDossier> {
  const result = await client.request({
    path: `/v1/assets/${encodeURIComponent(assetId)}/dossier`,
    schema: assetDossierSchema,
    signal,
  });

  return result.data;
}

export async function fetchTimeline(
  client: ApiClient,
  assetId: string,
  signal?: AbortSignal,
): Promise<TimelineEntry[]> {
  const result = await client.request({
    path: `/v1/assets/${encodeURIComponent(assetId)}/timeline`,
    schema: timelinePageSchema,
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}
