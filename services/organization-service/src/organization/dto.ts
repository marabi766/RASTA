import { z } from 'zod';
import { cursorPaginationSchema, seedIdSchema, ID_PREFIXES } from '@rasta/contracts';

/**
 * Request and response shapes for organizations.
 *
 * Every input schema is `.strict()`: an unknown field is rejected rather than
 * dropped. Silently ignoring a key the caller believed they set is how
 * "I configured that, why didn't it apply?" tickets are made.
 */

const organizationId = seedIdSchema(ID_PREFIXES.organization);

/**
 * The full extensible list. `DEHYARI` is one value among many, deliberately
 * not a default — the platform is meant to reach municipalities and national
 * bodies without a schema change (ADR-012).
 */
export const ORGANIZATION_TYPES = [
  'DEHYARI',
  'MUNICIPALITY',
  'UNION',
  'COOPERATIVE',
  'COMPANY',
  'GOVERNMENT',
  'PRIVATE',
  'NATIONAL_ORGANIZATION',
] as const;

export const ORGANIZATION_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export const LOCATION_KINDS = ['PRIMARY', 'WAREHOUSE', 'BRANCH', 'SITE'] as const;
export const CONTACT_KINDS = ['ADMINISTRATIVE', 'FINANCIAL', 'TECHNICAL', 'EMERGENCY'] as const;

export const organizationTypeSchema = z.enum(ORGANIZATION_TYPES);
export type OrganizationTypeValue = z.infer<typeof organizationTypeSchema>;

/** Persian display names, allowing ZWNJ (نیم‌فاصله) and the usual punctuation. */
const displayName = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .regex(
    /^[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s‌()«»'’\-.,/]+$/u,
    'Name contains unsupported characters',
  );

/** WGS 84 bounds. Rejects the classic swapped lat/lng, which lands in the sea. */
const coordinate = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict();

const locationInput = z
  .object({
    kind: z.enum(LOCATION_KINDS).default('PRIMARY'),
    addressLine: z.string().trim().max(500).optional(),
    city: z.string().trim().max(100).optional(),
    county: z.string().trim().max(100).optional(),
    province: z.string().trim().max(100).optional(),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{10}$/, 'Postal code must be 10 digits')
      .optional(),
    coordinate: coordinate.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const createOrganizationSchema = z
  .object({
    name: displayName,
    shortName: displayName.optional(),
    type: organizationTypeSchema,
    /** Omit for a root. Anything else must be an organization the caller may write to. */
    parentId: organizationId.optional(),
    externalCode: z.string().trim().min(1).max(64).optional(),
    /** Type-specific attributes. Kept free-form so a new type needs no migration. */
    metadata: z.record(z.unknown()).default({}),
    location: locationInput.optional(),
  })
  .strict();

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    name: displayName.optional(),
    shortName: displayName.nullable().optional(),
    externalCode: z.string().trim().min(1).max(64).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateOrganizationDto = z.infer<typeof updateOrganizationSchema>;

export const listOrganizationsQuerySchema = cursorPaginationSchema
  .extend({
    type: organizationTypeSchema.optional(),
    status: z.enum(ORGANIZATION_STATUSES).optional(),
    parentId: organizationId.optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;

export const moveOrganizationSchema = z
  .object({
    /** New parent, or null to make this a root. */
    parentId: organizationId.nullable(),
    /** Recorded on the audit event. Restructuring a hierarchy needs a stated why. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type MoveOrganizationDto = z.infer<typeof moveOrganizationSchema>;

export const changeStatusSchema = z
  .object({
    status: z.enum(ORGANIZATION_STATUSES),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

// ---------------------------------------------------------------------------
// Policies — configurable governance (ADR-023)
// ---------------------------------------------------------------------------

export const setPolicySchema = z
  .object({
    /** Namespaced, e.g. `approval.project.threshold_minor`. */
    key: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/, 'Policy key must be dot-namespaced lowercase'),
    value: z.unknown(),
    inheritable: z.boolean().default(true),
    /**
     * Why this value was set. Required: a governance setting nobody can
     * explain later is not auditable, and these rows decide who may approve
     * what.
     */
    description: z.string().trim().min(3).max(1000),
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.effectiveTo || !v.effectiveFrom || new Date(v.effectiveTo) > new Date(v.effectiveFrom),
    { message: 'effectiveTo must be after effectiveFrom' },
  );

export type SetPolicyDto = z.infer<typeof setPolicySchema>;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const createContactSchema = z
  .object({
    kind: z.enum(CONTACT_KINDS),
    displayName: displayName,
    phone: z
      .string()
      .trim()
      .regex(/^(?:\+98|0)(?:9\d{9}|[1-8]\d{9})$/, 'Phone must be a valid Iranian number')
      .optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    isPrimary: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.phone || v.email, { message: 'A contact needs a phone number or an email' });

export type CreateContactDto = z.infer<typeof createContactSchema>;

export const addLocationSchema = locationInput;
export type AddLocationDto = z.infer<typeof addLocationSchema>;

export const nearbyQuerySchema = z
  .object({
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    /** Search radius in metres. Capped so one query cannot scan the country. */
    radiusMeters: z.coerce.number().int().min(1).max(500_000).default(50_000),
    type: organizationTypeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface OrganizationView {
  id: string;
  externalCode: string | null;
  name: string;
  shortName: string | null;
  type: string;
  status: string;
  parentId: string | null;
  /** Materialised ancestry, root first. Lets a client render a breadcrumb without extra calls. */
  path: string | null;
  depth: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDetailView extends OrganizationView {
  locations: LocationView[];
  contacts: ContactView[];
  childCount: number;
}

export interface LocationView {
  id: string;
  kind: string;
  addressLine: string | null;
  city: string | null;
  county: string | null;
  province: string | null;
  postalCode: string | null;
  coordinate: { latitude: number; longitude: number } | null;
}

export interface ContactView {
  id: string;
  kind: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

export interface PolicyView {
  id: string;
  key: string;
  value: unknown;
  inheritable: boolean;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The organization the value actually came from — may be an ancestor. */
  inheritedFrom: string | null;
}
