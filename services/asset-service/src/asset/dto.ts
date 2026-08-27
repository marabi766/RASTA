import { z } from 'zod';
import {
  cursorPaginationSchema,
  seedIdSchema,
  ID_PREFIXES,
  amountMinorSchema,
} from '@rasta/contracts';

/**
 * Request and response shapes for assets.
 *
 * Every input schema is `.strict()`: an unknown field is rejected rather than
 * dropped, so a client that misspells a key hears about it instead of
 * wondering why nothing saved.
 */

const organizationId = seedIdSchema(ID_PREFIXES.organization);
const assetId = seedIdSchema(ID_PREFIXES.asset);

export const ASSET_TYPES = [
  'GRADER',
  'LOADER',
  'EXCAVATOR',
  'BULLDOZER',
  'TRUCK',
  'LIGHT_TRUCK',
  'TRACTOR',
  'WATER_TANKER',
  'WASTE_COLLECTOR',
  'EMERGENCY_VEHICLE',
  'PASSENGER_VEHICLE',
  'FIXED_EQUIPMENT',
  'OTHER',
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

export const DOCUMENT_KINDS = [
  'OWNERSHIP_TITLE',
  'REGISTRATION_CARD',
  'INSURANCE_POLICY',
  'TECHNICAL_INSPECTION',
  'PURCHASE_INVOICE',
  'MANUAL',
  'PHOTO',
  'OTHER',
] as const;

export const assetTypeSchema = z.enum(ASSET_TYPES);
export const operationalStatusSchema = z.enum(OPERATIONAL_STATUSES);

/** Persian display text, allowing ZWNJ and the usual punctuation. */
const displayText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(
      /^[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s‌()«»'’\-.,/:+]+$/u,
      'Contains unsupported characters',
    );

const coordinate = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const createAssetSchema = z
  .object({
    name: displayText(2, 200),
    type: assetTypeSchema,

    /**
     * The number a human reads — plate, fleet number, asset tag. Optional
     * because a newly delivered machine may not have one yet, and registration
     * must not be blocked on paperwork the platform does not control.
     */
    assetTag: z.string().trim().min(1).max(64).optional(),

    manufacturer: displayText(1, 120).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    serialNumber: z.string().trim().min(3).max(120).optional(),
    manufactureYear: z.coerce.number().int().min(1300).max(2100).optional(),

    /** Type-specific attributes; free-form so a new type needs no migration. */
    specifications: z.record(z.unknown()).default({}),

    location: z
      .object({
        siteName: displayText(1, 200).optional(),
        addressLine: z.string().trim().max(500).optional(),
        coordinate: coordinate.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateAssetDto = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({
    name: displayText(2, 200).optional(),
    assetTag: z.string().trim().min(1).max(64).nullable().optional(),
    manufacturer: displayText(1, 120).nullable().optional(),
    model: z.string().trim().min(1).max(120).nullable().optional(),
    manufactureYear: z.coerce.number().int().min(1300).max(2100).nullable().optional(),
    specifications: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateAssetDto = z.infer<typeof updateAssetSchema>;

/**
 * `serialNumber` is absent from the update schema on purpose. It identifies a
 * physical machine worldwide, so changing it means the row now describes a
 * different object — which is a new asset, not an edit.
 */

export const listAssetsQuerySchema = cursorPaginationSchema
  .extend({
    status: operationalStatusSchema.optional(),
    type: assetTypeSchema.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    /** Assets whose insurance or inspection lapses within N days. */
    expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict();

export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;

export const activateAssetSchema = z
  .object({
    commissionedAt: z.string().datetime().optional(),
  })
  .strict();

export type ActivateAssetDto = z.infer<typeof activateAssetSchema>;

export const changeStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'IDLE', 'OUT_OF_SERVICE']),
    /** Recorded on the event and the timeline. Withdrawing a machine from
     *  service without a stated why is not reviewable later. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

export const decommissionSchema = z
  .object({
    reason: z.string().trim().min(10).max(1000),
    decommissionedAt: z.string().datetime().optional(),
  })
  .strict();

export type DecommissionDto = z.infer<typeof decommissionSchema>;

export const transferAssetSchema = z
  .object({
    toOrganizationId: organizationId,
    reason: z.string().trim().min(10).max(1000),
    /** Board resolution or handover document number, where one exists. */
    referenceNo: z.string().trim().max(120).optional(),
  })
  .strict();

export type TransferAssetDto = z.infer<typeof transferAssetSchema>;

export const recordLocationSchema = z
  .object({
    coordinate: coordinate.optional(),
    siteName: displayText(1, 200).optional(),
    addressLine: z.string().trim().max(500).optional(),
    source: z.enum(['MANUAL', 'TELEMATICS', 'IMPORTED']).default('MANUAL'),
  })
  .strict()
  .refine((v) => v.coordinate || v.siteName || v.addressLine, {
    message: 'A location needs coordinates, a site name or an address',
  });

export type RecordLocationDto = z.infer<typeof recordLocationSchema>;

export const attachDocumentSchema = z
  .object({
    /** The id issued by document-service. The file never passes through here. */
    documentId: z.string().trim().min(1).max(64),
    kind: z.enum(DOCUMENT_KINDS),
    title: displayText(2, 200),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export type AttachDocumentDto = z.infer<typeof attachDocumentSchema>;

export const nearbyQuerySchema = z
  .object({
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().int().min(1).max(500_000).default(50_000),
    type: assetTypeSchema.optional(),
    /** Only assets that could actually be dispatched. */
    availableOnly: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;

/**
 * Sections of the dossier.
 *
 * Declared once and used three ways — the query filter, the type the service
 * writes, and the grouping the dossier reports costs by — so a new section
 * cannot be added to one and forgotten in the others.
 */
export const TIMELINE_CATEGORIES = [
  'LIFECYCLE',
  'USAGE',
  'MAINTENANCE',
  'INSURANCE',
  'INSPECTION',
  'DOCUMENT',
  'COST',
  'PROJECT',
  'TRANSFER',
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const timelineQuerySchema = cursorPaginationSchema
  .extend({
    category: z.enum(TIMELINE_CATEGORIES).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface AssetView {
  id: string;
  organizationId: string;
  assetTag: string | null;
  name: string;
  type: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  manufactureYear: number | null;
  status: string;
  commissionedAt: string | null;
  decommissionedAt: string | null;
  specifications: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AssetLocationView {
  id: string;
  siteName: string | null;
  addressLine: string | null;
  coordinate: { latitude: number; longitude: number } | null;
  source: string;
  recordedAt: string;
}

export interface InsurancePolicyView {
  id: string;
  policyNumber: string;
  insurerName: string;
  coverage: string;
  premiumMinor: string | null;
  insuredValueMinor: string | null;
  validFrom: string;
  validTo: string;
  status: string;
  /** Negative once lapsed, so a client can render "expired 3 days ago". */
  daysUntilExpiry: number;
}

export interface InspectionView {
  id: string;
  certificateNo: string;
  centerName: string | null;
  inspectedAt: string;
  validTo: string;
  result: string;
  notes: string | null;
  daysUntilExpiry: number;
}

export interface TimelineEntryView {
  id: string;
  eventName: string;
  sourceService: string;
  category: string;
  title: string;
  description: string | null;
  amountMinor: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/**
 * The electronic dossier (پرونده الکترونیکی).
 *
 * The product document's central promise for fleet management: one place that
 * answers what this machine is, whether it may be used today, what it has
 * cost, and what has happened to it.
 */
export interface AssetDossierView {
  asset: AssetView;
  organizationName: string | null;
  currentLocation: AssetLocationView | null;

  compliance: {
    /** Whether the asset may legally and safely be dispatched right now. */
    operable: boolean;
    /** Every reason it is not, rather than only the first — an operator
     *  fixing one blocker should not have to re-check to find the next. */
    blockers: string[];
    activeInsurance: InsurancePolicyView | null;
    latestInspection: InspectionView | null;
  };

  costs: {
    /** Rial minor units, accumulated from timeline entries. */
    totalMinor: string;
    maintenanceMinor: string;
    partsAndOrdersMinor: string;
    entryCount: number;
  };

  documents: Array<{
    id: string;
    documentId: string;
    kind: string;
    title: string;
    issuedAt: string | null;
    expiresAt: string | null;
  }>;

  recentActivity: TimelineEntryView[];
  transferCount: number;
}

export const createPolicySchema = z
  .object({
    policyNumber: z.string().trim().min(3).max(64),
    insurerName: displayText(2, 200),
    coverage: z.enum(['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY']),
    premiumMinor: amountMinorSchema.optional(),
    insuredValueMinor: amountMinorSchema.optional(),
    validFrom: z.string().datetime(),
    validTo: z.string().datetime(),
    documentId: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine((v) => new Date(v.validTo) > new Date(v.validFrom), {
    message: 'validTo must be after validFrom',
  });

export type CreatePolicyDto = z.infer<typeof createPolicySchema>;

export const createInspectionSchema = z
  .object({
    certificateNo: z.string().trim().min(3).max(64),
    centerName: displayText(2, 200).optional(),
    inspectedAt: z.string().datetime(),
    validTo: z.string().datetime(),
    result: z.enum(['PASSED', 'CONDITIONAL', 'FAILED']),
    notes: z.string().trim().max(1000).optional(),
    documentId: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine((v) => new Date(v.validTo) > new Date(v.inspectedAt), {
    message: 'validTo must be after inspectedAt',
  });

export type CreateInspectionDto = z.infer<typeof createInspectionSchema>;

export { assetId as assetIdSchema };
