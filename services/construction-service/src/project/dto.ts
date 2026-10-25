import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { PROJECT_STATES } from './project.state-machine';
import { NEED_STATES } from './need.state-machine';

/**
 * The request and response shapes, validated at the boundary (AGENTS.md § 3,
 * `docs/06` § 6.4). The OpenAPI document is generated from these same schemas
 * (`src/openapi/document.ts`), so the contract and the validator cannot drift.
 *
 * ## `.strict()` is a security control here
 *
 * The fields a client may **not** send are the security-relevant ones:
 *
 *   organizationId    decided by the verified token (and `X-Organization-Id`),
 *                     never by the body. A body field would let a caller file a
 *                     project under somebody else's organization.
 *   status            decided only by lifecycle commands. A client that could
 *                     set it would approve its own project.
 *   createdBy, …      taken from the request context, so a change always names
 *                     the human who made it (S-06).
 *   version           read from the row; the client sends `expectedVersion`,
 *                     which is a precondition, not a value.
 *
 * `.strict()` is what turns each of those into a `400` instead of a value that
 * is quietly ignored today and quietly honoured by a careless change tomorrow.
 *
 * ## Where the fields come from
 *
 * The product document is not in the repository. The project fields are
 * exactly the ones `docs/03` names (title, operation type, location, scope of
 * work, estimate) plus the operating area of `docs/05` § 5.7; the need fields
 * are the provisional answer to Q-68. Each is marked in its description, so a
 * reader of the published contract can see which facts are provisional.
 */

const PROVISIONAL = 'Provisional field (docs/24 Q-68): taken from';

/** The largest value a PostgreSQL BIGINT holds. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Rial minor units as a decimal string (AGENTS.md § 3). Never a number: an
 * estimate above 2^53 would lose precision in JSON.
 */
export const amountMinorInput = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/, 'An amount is a non-negative integer string in rial minor units')
  // Zod runs a refinement even when the regex already failed, so it must not
  // assume a well-formed value: `BigInt('1.5')` throws rather than returning.
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= BIGINT_MAX,
    'The amount exceeds the largest storable value',
  );

/**
 * A decimal quantity as a string, up to four decimal places. Never a float.
 * Strictly positive: a zero quantity is not a requirement.
 */
export const quantityInput = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/,
    'A quantity is a positive decimal string with at most 14 integer and 4 fractional digits',
  )
  .refine((value) => /[1-9]/.test(value), 'A quantity must be greater than zero');

/** Why, stated for somebody reading the record months later (S-06). */
const statedReason = z.string().trim().min(8).max(500);

/** The compare-and-set precondition every change carries (ADR-063). */
const expectedVersion = z.number().int().min(1).max(2_147_483_647);

// ---------------------------------------------------------------------------
// The operating area — a GeoJSON Polygon (docs/05 § 5.7)
// ---------------------------------------------------------------------------

export const MAX_RING_POSITIONS = 1000;
export const MAX_RINGS = 20;
export const MAX_AREA_POSITIONS = 5000;

const position = z.array(z.number().finite()).length(2);
const ring = z.array(position).min(4).max(MAX_RING_POSITIONS);

/**
 * A GeoJSON Polygon in WGS 84: `[longitude, latitude]`, each ring closed.
 *
 * Structure and bounds are checked here; geometric validity (a ring that
 * crosses itself) is checked by PostGIS through `ck_project_area_valid`, and a
 * refusal there is reported as a `400` on this field.
 */
export const polygonInput = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(ring).min(1).max(MAX_RINGS),
  })
  .strict()
  .superRefine((value, ctx) => {
    let total = 0;
    value.coordinates.forEach((points, ringIndex) => {
      total += points.length;
      points.forEach(([longitude, latitude], positionIndex) => {
        if (
          longitude === undefined ||
          latitude === undefined ||
          longitude < -180 ||
          longitude > 180 ||
          latitude < -90 ||
          latitude > 90
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['coordinates', ringIndex, positionIndex],
            message: 'A position is [longitude, latitude] within [-180, 180] and [-90, 90]',
          });
        }
      });
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordinates', ringIndex],
          message: 'A ring must end where it starts',
        });
      }
    });
    if (total > MAX_AREA_POSITIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coordinates'],
        message: `An operating area may have at most ${MAX_AREA_POSITIONS} positions`,
      });
    }
  });

export type PolygonInput = z.infer<typeof polygonInput>;

// ---------------------------------------------------------------------------
// Project commands
// ---------------------------------------------------------------------------

const title = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .describe(`${PROVISIONAL} docs/03 «عنوان», not from the product document.`);
const operationType = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .describe(
    `${PROVISIONAL} docs/03 «نوع عملیات». Free text unless CONSTRUCTION_OPERATION_TYPES configures a list.`,
  );
const scopeOfWork = z
  .string()
  .trim()
  .min(1)
  .max(5000)
  .describe(`${PROVISIONAL} docs/03 «شرح کار».`);
const locationDescription = z
  .string()
  .trim()
  .min(2)
  .max(500)
  .describe(`${PROVISIONAL} docs/03 «محل», as text.`);
const area = polygonInput.describe(
  `${PROVISIONAL} docs/05 § 5.7 (project area, GEOGRAPHY(Polygon, 4326)). GeoJSON, [longitude, latitude].`,
);
const estimatedCostMinor = amountMinorInput.describe(
  `${PROVISIONAL} docs/03 «برآورد». Rial minor units as a string.`,
);

export const createProjectSchema = z
  .object({
    title,
    operationType,
    scopeOfWork,
    locationDescription,
    area: area.optional(),
    estimatedCostMinor: estimatedCostMinor.optional(),
  })
  .strict();

export type CreateProjectDto = z.infer<typeof createProjectSchema>;

/**
 * UpdateProject. Every field optional, at least one present; `null` clears the
 * two optional fields. Allowed only while the project is editable.
 */
export const updateProjectSchema = z
  .object({
    expectedVersion,
    title: title.optional(),
    operationType: operationType.optional(),
    scopeOfWork: scopeOfWork.optional(),
    locationDescription: locationDescription.optional(),
    area: area.nullable().optional(),
    estimatedCostMinor: estimatedCostMinor.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), {
    message: 'An update must change at least one field',
  });

export type UpdateProjectDto = z.infer<typeof updateProjectSchema>;

export const cancelProjectSchema = z
  .object({
    expectedVersion,
    reason: statedReason,
  })
  .strict();

export type CancelProjectDto = z.infer<typeof cancelProjectSchema>;

export const listProjectsQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(PROJECT_STATES).optional(),
  })
  .strict();

export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// ---------------------------------------------------------------------------
// Need commands
// ---------------------------------------------------------------------------

const needTitle = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .describe(`${PROVISIONAL} the CON-001 design note: what this line of the project requires.`);
const needDescription = z.string().trim().min(1).max(2000);
const needQuantity = quantityInput.describe(
  `${PROVISIONAL} the CON-001 design note. A decimal string, never a float.`,
);
const needUnit = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .describe(`${PROVISIONAL} the CON-001 design note. Free text; no unit list is defined.`);

export const createNeedSchema = z
  .object({
    title: needTitle,
    description: needDescription,
    quantity: needQuantity.optional(),
    unit: needUnit.optional(),
    estimatedCostMinor: estimatedCostMinor.optional(),
  })
  .strict();

export type CreateNeedDto = z.infer<typeof createNeedSchema>;

export const updateNeedSchema = z
  .object({
    expectedVersion,
    title: needTitle.optional(),
    description: needDescription.optional(),
    quantity: needQuantity.nullable().optional(),
    unit: needUnit.nullable().optional(),
    estimatedCostMinor: estimatedCostMinor.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), {
    message: 'An update must change at least one field',
  });

export type UpdateNeedDto = z.infer<typeof updateNeedSchema>;

export const submitNeedSchema = z.object({ expectedVersion }).strict();

export type SubmitNeedDto = z.infer<typeof submitNeedSchema>;

export const withdrawNeedSchema = z
  .object({
    expectedVersion,
    reason: statedReason,
  })
  .strict();

export type WithdrawNeedDto = z.infer<typeof withdrawNeedSchema>;

export const listNeedsQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(NEED_STATES).optional(),
  })
  .strict();

export type ListNeedsQuery = z.infer<typeof listNeedsQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes — one definition for the service's return types and for the
// published contract.
// ---------------------------------------------------------------------------

const polygonView = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.array(z.number()))),
  })
  .strict();

const needsSummaryView = z
  .object({
    draft: z.number().int(),
    submitted: z.number().int(),
    withdrawn: z.number().int(),
  })
  .strict();

/** What a listing returns: no scope-of-work prose and no polygon. */
export const projectSummaryViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    title: z.string(),
    operationType: z.string(),
    locationDescription: z.string(),
    hasArea: z.boolean(),
    estimatedCostMinor: z.string().nullable(),
    status: z.enum(PROJECT_STATES),
    statusReason: z.string().nullable(),
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

export const projectViewSchema = projectSummaryViewSchema
  .extend({
    scopeOfWork: z.string(),
    area: polygonView.nullable(),
    needsSummary: needsSummaryView,
  })
  .strict();

export const needViewSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    description: z.string(),
    quantity: z.string().nullable(),
    unit: z.string().nullable(),
    estimatedCostMinor: z.string().nullable(),
    status: z.enum(NEED_STATES),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
    submittedAt: z.string().nullable(),
    submittedBy: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
    withdrawnBy: z.string().nullable(),
    withdrawalReason: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();

export type ProjectSummaryView = z.infer<typeof projectSummaryViewSchema>;
export type ProjectView = z.infer<typeof projectViewSchema>;
export type NeedView = z.infer<typeof needViewSchema>;
