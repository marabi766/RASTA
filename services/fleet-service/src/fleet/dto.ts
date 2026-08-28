import { z } from 'zod';
import { cursorPaginationSchema, seedIdSchema, ID_PREFIXES } from '@rasta/contracts';

/**
 * Request and response shapes for fleet.
 *
 * Every input schema is `.strict()`: an unknown field is rejected rather than
 * dropped, so a client that misspells a key hears about it instead of
 * wondering why nothing saved.
 */

const assetId = seedIdSchema(ID_PREFIXES.asset);
const userId = seedIdSchema(ID_PREFIXES.user);
const driverId = seedIdSchema(ID_PREFIXES.driver);

export const DRIVER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export const USAGE_SOURCES = ['MANUAL', 'TELEMATICS', 'IMPORTED'] as const;
export const ASSIGNMENT_END_REASONS = [
  'COMPLETED',
  'CANCELLED',
  'DRIVER_UNAVAILABLE',
  'ASSET_UNAVAILABLE',
  'REASSIGNED',
] as const;

export const driverStatusSchema = z.enum(DRIVER_STATUSES);
export const usageSourceSchema = z.enum(USAGE_SOURCES);
export const assignmentEndReasonSchema = z.enum(ASSIGNMENT_END_REASONS);

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

/**
 * A non-negative quantity with at most two decimals, accepted as a string.
 *
 * A string rather than a number for the same reason money is (ADR-022): the
 * column is NUMERIC, and routing the value through a JSON float on the way in
 * would reintroduce the drift the column type exists to prevent. Hours feed
 * maintenance schedules, so the drift would eventually be a machine that
 * missed its service.
 */
const quantity = (maxIntegerDigits: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Expected a non-negative number with at most two decimals')
    .refine((value) => (value.split('.')[0] ?? '').length <= maxIntegerDigits, {
      message: `At most ${maxIntegerDigits} digits before the decimal point`,
    });

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const createDriverSchema = z
  .object({
    /**
     * The platform user this driver is. Required: object-level authorization
     * for the DRIVER and OPERATOR roles resolves through it, and a driver row
     * with no user is a row that check can never match.
     */
    userId,

    employeeNo: z.string().trim().min(1).max(64).optional(),

    licenceNumber: z.string().trim().min(1).max(64).optional(),
    licenceClass: z.string().trim().min(1).max(32).optional(),
    licenceValidTo: z.string().datetime().optional(),

    notes: displayText(1, 1000).optional(),
  })
  .strict();

export type CreateDriverDto = z.infer<typeof createDriverSchema>;

export const updateDriverSchema = z
  .object({
    employeeNo: z.string().trim().min(1).max(64).nullable().optional(),
    licenceNumber: z.string().trim().min(1).max(64).nullable().optional(),
    licenceClass: z.string().trim().min(1).max(32).nullable().optional(),
    licenceValidTo: z.string().datetime().nullable().optional(),
    notes: displayText(1, 1000).nullable().optional(),
  })
  .strict()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'No fields to update' });

export type UpdateDriverDto = z.infer<typeof updateDriverSchema>;

export const changeDriverStatusSchema = z
  .object({
    status: driverStatusSchema,
    /**
     * Required, not optional. A driver barred from work without a recorded
     * reason is a decision nobody can review later, and AGENTS.md S-06 asks
     * every state change to say who did what and why.
     */
    reason: displayText(3, 500),
  })
  .strict();

export type ChangeDriverStatusDto = z.infer<typeof changeDriverStatusSchema>;

export const listDriversQuerySchema = cursorPaginationSchema
  .extend({
    status: driverStatusSchema.optional(),
    userId: userId.optional(),
    /** Free-text over employee number and licence number. */
    q: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type ListDriversQuery = z.infer<typeof listDriversQuerySchema>;

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export const createAssignmentSchema = z
  .object({
    driverId,
    assetId,
    /**
     * Defaults to now. Accepted so a fleet manager can record an assignment
     * that started earlier in the day, which is how the paperwork actually
     * arrives. Future timestamps are refused: this service does not model
     * scheduled assignments, and accepting one would make `ended_at IS NULL`
     * mean "active" for something that has not begun.
     */
    startedAt: z.string().datetime().optional(),
    purpose: displayText(2, 500).optional(),
  })
  .strict();

export type CreateAssignmentDto = z.infer<typeof createAssignmentSchema>;

export const endAssignmentSchema = z
  .object({
    reason: assignmentEndReasonSchema.default('COMPLETED'),
    endedAt: z.string().datetime().optional(),
    notes: displayText(2, 500).optional(),
  })
  .strict();

export type EndAssignmentDto = z.infer<typeof endAssignmentSchema>;

export const listAssignmentsQuerySchema = cursorPaginationSchema
  .extend({
    driverId: driverId.optional(),
    assetId: assetId.optional(),
    /** `true` for currently active, `false` for ended, omitted for both. */
    active: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const recordUsageSchema = z
  .object({
    assetId,
    /**
     * Optional: a machine can be operated by someone with no driver record —
     * a contractor's operator, for instance — and refusing to record that
     * would lose real usage rather than improve data quality.
     */
    driverId: driverId.optional(),

    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),

    /** Engine hours consumed during the period. */
    hours: quantity(8).optional(),
    /** Kilometres travelled during the period. */
    kilometres: quantity(10).optional(),

    /** Instrument readings at the end of the period. */
    hourMeter: quantity(10).optional(),
    odometer: quantity(10).optional(),

    source: usageSourceSchema.default('MANUAL'),
    notes: displayText(1, 1000).optional(),

    /**
     * Deduplication key for offline capture.
     *
     * The product asks for a field PWA that queues readings and syncs later
     * (docs/17), which means the same reading will be submitted twice. A
     * resubmission carrying the same reference returns the original record
     * instead of creating a second one.
     */
    clientReference: z.string().trim().min(8).max(128).optional(),
  })
  .strict()
  .refine((dto) => dto.hours !== undefined || dto.kilometres !== undefined, {
    message: 'Record at least one of hours or kilometres',
    path: ['hours'],
  })
  .refine((dto) => new Date(dto.periodEnd) > new Date(dto.periodStart), {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  });

export type RecordUsageDto = z.infer<typeof recordUsageSchema>;

export const listUsageQuerySchema = cursorPaginationSchema
  .extend({
    assetId: assetId.optional(),
    driverId: driverId.optional(),
    source: usageSourceSchema.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export type ListUsageQuery = z.infer<typeof listUsageQuerySchema>;

// ---------------------------------------------------------------------------
// Availability and utilization
// ---------------------------------------------------------------------------

export const declareAvailabilitySchema = z
  .object({
    assetId,
    available: z.boolean(),
    fromAt: z.string().datetime().optional(),
    toAt: z.string().datetime().optional(),
    reason: displayText(3, 500),
  })
  .strict()
  .refine((dto) => !dto.toAt || !dto.fromAt || new Date(dto.toAt) > new Date(dto.fromAt), {
    message: 'toAt must be after fromAt',
    path: ['toAt'],
  });

export type DeclareAvailabilityDto = z.infer<typeof declareAvailabilitySchema>;

export const availabilityQuerySchema = cursorPaginationSchema
  .extend({
    assetId: assetId.optional(),
    /** Restrict to machines that can be dispatched right now. */
    availableOnly: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    at: z.string().datetime().optional(),
  })
  .strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const utilizationQuerySchema = z
  .object({
    assetId: assetId.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type UtilizationQuery = z.infer<typeof utilizationQuerySchema>;

// ---------------------------------------------------------------------------
// Views
//
// Explicit whitelists, so a new column is never exposed by accident.
// ---------------------------------------------------------------------------

export interface DriverView {
  id: string;
  organizationId: string;
  userId: string;
  employeeNo: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  licenceValidTo: string | null;
  status: string;
  statusReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentView {
  id: string;
  organizationId: string;
  driverId: string;
  assetId: string;
  active: boolean;
  startedAt: string;
  endedAt: string | null;
  purpose: string | null;
  endReason: string | null;
  endNotes: string | null;
  assignedBy: string;
  endedBy: string | null;
}

export interface UsageRecordView {
  id: string;
  organizationId: string;
  assetId: string;
  driverId: string | null;
  assignmentId: string | null;
  periodStart: string;
  periodEnd: string;
  hours: string | null;
  kilometres: string | null;
  hourMeter: string | null;
  odometer: string | null;
  source: string;
  notes: string | null;
  clientReference: string | null;
  recordedAt: string;
}

export interface AvailabilityWindowView {
  id: string;
  assetId: string;
  available: boolean;
  fromAt: string;
  toAt: string | null;
  reason: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * One machine's dispatchability, with every blocker named and attributed.
 *
 * The attribution is the point. Availability is assembled from facts four
 * different services own, and an operator told only "unavailable" has no way
 * to know whether to call the workshop, renew a policy, or end an assignment
 * (ADR-026).
 */
export interface AvailabilityView {
  assetId: string;
  assetName: string | null;
  assetType: string | null;
  assetTag: string | null;
  available: boolean;
  /** Machine-readable blockers, most specific first. */
  blockers: AvailabilityBlocker[];
  currentAssignment: {
    id: string;
    driverId: string;
    startedAt: string;
  } | null;
}

export interface AvailabilityBlocker {
  code:
    | 'ASSET_STATUS'
    | 'IN_MAINTENANCE'
    | 'DISPATCH_BLOCKED'
    | 'ACTIVE_ASSIGNMENT'
    | 'DECLARED_UNAVAILABLE';
  /** Which service owns the fact behind this blocker. */
  owner: string;
  detail: string;
}

export interface UtilizationView {
  assetId: string;
  assetName: string | null;
  from: string;
  to: string;
  /** Hours recorded against the machine in the window. */
  usedHours: string;
  kilometres: string;
  /** Hours the machine was considered available, from configuration. */
  availableHours: string;
  /**
   * `usedHours / availableHours`, as a percentage with one decimal.
   *
   * Null rather than zero when the window contains no usage records at all:
   * "we have no readings" and "the machine sat idle" are different facts, and
   * reporting the first as the second is how a dashboard invents data
   * (docs/04 § 4.15, the `INSUFFICIENT_BASELINE` rule).
   */
  utilizationPercent: string | null;
  recordCount: number;
  assignmentCount: number;
}
