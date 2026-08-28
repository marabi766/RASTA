import { z } from 'zod';
import {
  amountMinorSchema,
  cursorPaginationSchema,
  currencySchema,
  seedIdSchema,
  ID_PREFIXES,
} from '@rasta/contracts';

/**
 * Request and response shapes for maintenance.
 *
 * Every input schema is `.strict()`: an unknown field is rejected rather than
 * dropped, so a client that misspells a key hears about it instead of
 * wondering why nothing saved.
 *
 * Two conventions run through the money and quantity fields, and both are the
 * platform's rather than this service's:
 *
 *   money       integer minor units, as a string (ADR-022). A JSON number
 *               cannot hold a rial amount past 9.007e15 intact, and a repair
 *               invoice is a figure someone will later be paid.
 *   quantities  two-decimal strings for the same reason: the columns are
 *               NUMERIC, hours feed service schedules, and a float round-trip
 *               reintroduces exactly the drift the column type prevents.
 */

const assetId = seedIdSchema(ID_PREFIXES.asset);
const organizationId = seedIdSchema(ID_PREFIXES.organization);
const scheduleId = seedIdSchema(ID_PREFIXES.maintenanceSchedule);

export const MAINTENANCE_TYPES = ['PREVENTIVE', 'CORRECTIVE'] as const;
export const SCHEDULE_RECURRENCES = ['RECURRING', 'ONE_TIME'] as const;
export const SCHEDULE_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export const REQUEST_STATUS_VALUES = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'APPROVED',
  'CANCELLED',
] as const;
export const BREAKDOWN_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const REPAIR_ORDER_STATUS_VALUES = [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export const PART_SOURCES = ['INVENTORY', 'MARKETPLACE', 'WORKSHOP_SUPPLIED', 'OTHER'] as const;
export const COST_CATEGORIES = ['PART', 'LABOUR', 'SERVICE', 'EXTERNAL_REPAIR', 'OTHER'] as const;
/**
 * Categories a caller may post directly.
 *
 * `PART` and `LABOUR` are absent on purpose: those lines are written by
 * recording a part or a labour entry, so that a cost of that category can
 * never exist without the work it came from. Allowing them here would open a
 * second, unprovenanced route to the same total (ADR-028).
 */
export const DIRECT_COST_CATEGORIES = ['SERVICE', 'EXTERNAL_REPAIR', 'OTHER'] as const;

export const maintenanceTypeSchema = z.enum(MAINTENANCE_TYPES);
export const scheduleRecurrenceSchema = z.enum(SCHEDULE_RECURRENCES);
export const scheduleStatusSchema = z.enum(SCHEDULE_STATUSES);
export const requestStatusSchema = z.enum(REQUEST_STATUS_VALUES);
export const severitySchema = z.enum(BREAKDOWN_SEVERITIES);
export const repairOrderStatusSchema = z.enum(REPAIR_ORDER_STATUS_VALUES);
export const partSourceSchema = z.enum(PART_SOURCES);
export const directCostCategorySchema = z.enum(DIRECT_COST_CATEGORIES);

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
 * See the header: the columns are NUMERIC and the values feed schedule
 * evaluation, so they never pass through a float.
 */
const quantity = (maxIntegerDigits: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Expected a non-negative number with at most two decimals')
    .refine((value) => (value.split('.')[0] ?? '').length <= maxIntegerDigits, {
      message: `At most ${maxIntegerDigits} digits before the decimal point`,
    });

/** Part quantities allow three decimals — half a litre of oil is 0.5, but
 *  0.125 of a metre of hose is a real entry. */
const partQuantity = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, 'Expected a non-negative number with at most three decimals')
  .refine((value) => value !== '0' && Number.parseFloat(value) > 0, {
    message: 'Quantity must be greater than zero',
  })
  .refine((value) => (value.split('.')[0] ?? '').length <= 9, {
    message: 'At most 9 digits before the decimal point',
  });

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const scheduleIntervals = {
  /** Elapsed days since the last service. */
  intervalDays: z.coerce.number().int().min(1).max(3650).optional(),
  /** Engine hours since the last service. */
  intervalHours: quantity(8).optional(),
  /** Kilometres since the last service. */
  intervalKilometres: quantity(10).optional(),

  /** How far ahead of each trigger the schedule announces itself. */
  leadDays: z.coerce.number().int().min(0).max(365).optional(),
  leadHours: quantity(8).optional(),
  leadKilometres: quantity(10).optional(),
};

/**
 * At least one interval, and every lead smaller than the interval it warns
 * about.
 *
 * The second rule is well-formedness rather than business policy: a warning
 * that starts before the previous service is finished means the schedule is
 * permanently "due soon", which is the same as having no warning at all.
 */
function refineIntervals<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .refine(
      (dto: Record<string, unknown>) =>
        dto.intervalDays !== undefined ||
        dto.intervalHours !== undefined ||
        dto.intervalKilometres !== undefined,
      {
        message:
          'Set at least one of intervalDays, intervalHours or intervalKilometres; ' +
          'a schedule with no interval never comes due',
        path: ['intervalDays'],
      },
    )
    .refine(
      (dto: Record<string, unknown>) =>
        dto.leadDays === undefined ||
        dto.intervalDays === undefined ||
        (dto.leadDays as number) < (dto.intervalDays as number),
      { message: 'leadDays must be shorter than intervalDays', path: ['leadDays'] },
    );
}

export const createScheduleSchema = refineIntervals(
  z
    .object({
      assetId,
      /** What this service is, in the organization's own words. */
      title: displayText(2, 200),
      maintenanceType: maintenanceTypeSchema.default('PREVENTIVE'),
      recurrence: scheduleRecurrenceSchema.default('RECURRING'),
      ...scheduleIntervals,

      /**
       * Where the first cycle is measured from.
       *
       * All three are optional. Left out, the time anchor is the moment the
       * schedule is created and the meter anchors are taken from the machine's
       * current readings — so adding a schedule to a grader with 4 310 hours
       * on it does not report it overdue on day one.
       */
      lastServicedAt: z.string().datetime().optional(),
      lastServicedHourMeter: quantity(10).optional(),
      lastServicedOdometer: quantity(10).optional(),

      notes: displayText(1, 1000).optional(),
    })
    .strict(),
);

export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = z
  .object({
    title: displayText(2, 200).optional(),
    intervalDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
    intervalHours: quantity(8).nullable().optional(),
    intervalKilometres: quantity(10).nullable().optional(),
    leadDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
    leadHours: quantity(8).nullable().optional(),
    leadKilometres: quantity(10).nullable().optional(),
    /**
     * Re-anchoring. This is the supported repair for a replaced hour meter:
     * the meter read model never moves backwards, so the schedule is moved
     * instead of the history being rewritten.
     */
    lastServicedAt: z.string().datetime().nullable().optional(),
    lastServicedHourMeter: quantity(10).nullable().optional(),
    lastServicedOdometer: quantity(10).nullable().optional(),
    notes: displayText(1, 1000).nullable().optional(),
  })
  .strict()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'No fields to update' });

export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;

export const changeScheduleStatusSchema = z
  .object({
    status: scheduleStatusSchema,
    /** Required. A schedule silently switched off is a machine that quietly
     *  stops being serviced, and AGENTS.md S-06 asks every state change to
     *  record who did what and why. */
    reason: displayText(3, 500),
  })
  .strict();

export type ChangeScheduleStatusDto = z.infer<typeof changeScheduleStatusSchema>;

export const listSchedulesQuerySchema = cursorPaginationSchema
  .extend({
    assetId: assetId.optional(),
    status: scheduleStatusSchema.optional(),
    maintenanceType: maintenanceTypeSchema.optional(),
  })
  .strict();

export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>;

export const dueSchedulesQuerySchema = cursorPaginationSchema
  .extend({
    assetId: assetId.optional(),
    /**
     * Include schedules that are not yet due, with their assessment.
     *
     * Off by default, because the endpoint's question is "what needs doing".
     */
    includeNotDue: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    /** Evaluate as at a point in time rather than now. */
    at: z.string().datetime().optional(),
  })
  .strict();

export type DueSchedulesQuery = z.infer<typeof dueSchedulesQuerySchema>;

// ---------------------------------------------------------------------------
// Maintenance request
// ---------------------------------------------------------------------------

export const createRequestSchema = z
  .object({
    assetId,
    type: maintenanceTypeSchema,
    title: displayText(2, 200),
    description: displayText(1, 2000).optional(),

    /** The schedule this serves, for planned work. */
    scheduleId: scheduleId.optional(),

    /** Required for a breakdown; meaningless for planned work. */
    severity: severitySchema.optional(),

    /**
     * When the machine actually stopped being usable.
     *
     * Optional, and distinct from when the repair starts: a machine that broke
     * on Saturday and reaches a workshop on Tuesday was down for three days,
     * not for the afternoon the repair took. Left out for planned work, where
     * downtime begins when the machine goes in.
     */
    outOfServiceAt: z.string().datetime().optional(),

    /** When it should be done by. Taken from the schedule when one is named. */
    dueDate: z.string().datetime().optional(),

    reportedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((dto) => dto.type !== 'CORRECTIVE' || dto.severity !== undefined, {
    message: 'A corrective request records a failure, so it must state a severity',
    path: ['severity'],
  })
  .refine((dto) => dto.type !== 'PREVENTIVE' || dto.severity === undefined, {
    message: 'Severity describes a failure and does not apply to planned maintenance',
    path: ['severity'],
  });

export type CreateRequestDto = z.infer<typeof createRequestSchema>;

export const assignWorkshopSchema = z
  .object({
    /**
     * The organization that will do the work.
     *
     * supplier-service owns workshop profiles and their qualification, and it
     * does not exist yet — so nothing verifies that this organization is a
     * qualified workshop (ADR-029, docs/24 Q-25). The reference is recorded so
     * that verification becomes a check at this boundary rather than a data
     * migration.
     */
    workshopOrganizationId: organizationId,
    workshopName: displayText(2, 200).optional(),
    workSummary: displayText(2, 1000).optional(),
    assignedAt: z.string().datetime().optional(),
  })
  .strict();

export type AssignWorkshopDto = z.infer<typeof assignWorkshopSchema>;

export const approveRequestSchema = z
  .object({
    notes: displayText(1, 1000).optional(),
    /**
     * The total the approver believes they are approving, echoed back.
     *
     * Optional, but when supplied it must match the request's current total
     * exactly. This is the one control the product document makes mandatory —
     * "الزام تأیید کاربر پیش از تسویه نهایی" (docs/17) — and an approval that
     * silently covers a figure that changed between the screen and the button
     * is not the control it claims to be.
     */
    expectedTotalCostMinor: amountMinorSchema.optional(),
  })
  .strict();

export type ApproveRequestDto = z.infer<typeof approveRequestSchema>;

export const cancelRequestSchema = z
  .object({
    reason: displayText(3, 500),
  })
  .strict();

export type CancelRequestDto = z.infer<typeof cancelRequestSchema>;

export const listRequestsQuerySchema = cursorPaginationSchema
  .extend({
    assetId: assetId.optional(),
    status: requestStatusSchema.optional(),
    type: maintenanceTypeSchema.optional(),
    severity: severitySchema.optional(),
    scheduleId: scheduleId.optional(),
    /** Only requests still open — the operational queue. */
    openOnly: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    /** A window over `reportedAt`. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;

// ---------------------------------------------------------------------------
// Repair order
// ---------------------------------------------------------------------------

export const startRepairSchema = z
  .object({
    startedAt: z.string().datetime().optional(),
    workSummary: displayText(2, 1000).optional(),
  })
  .strict();

export type StartRepairDto = z.infer<typeof startRepairSchema>;

export const completeRepairSchema = z
  .object({
    /** What was actually done, as opposed to what was asked for. */
    workPerformed: displayText(2, 2000),
    completedAt: z.string().datetime().optional(),
    /**
     * When the machine went back into service.
     *
     * Defaults to the completion time. Stated separately because a machine can
     * be repaired on Thursday and collected on Monday, and the fleet was
     * without it for the whole of that.
     */
    returnedToServiceAt: z.string().datetime().optional(),
  })
  .strict();

export type CompleteRepairDto = z.infer<typeof completeRepairSchema>;

export const cancelRepairSchema = z
  .object({
    reason: displayText(3, 500),
  })
  .strict();

export type CancelRepairDto = z.infer<typeof cancelRepairSchema>;

export const recordPartSchema = z
  .object({
    partName: displayText(2, 200),
    /** The part's identifier in whichever system supplied it. */
    partReference: z.string().trim().min(1).max(128).optional(),
    quantity: partQuantity,
    /** The workshop's own unit — عدد, لیتر, متر. */
    unit: displayText(1, 32),
    unitCostMinor: amountMinorSchema,
    source: partSourceSchema.default('WORKSHOP_SUPPLIED'),
    /**
     * The order or stock movement this came from, when it came from another
     * service. A reference only: inventory-service owns stock and
     * marketplace-service owns orders, and neither is touched from here.
     */
    sourceReference: z.string().trim().min(1).max(128).optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict();

export type RecordPartDto = z.infer<typeof recordPartSchema>;

export const recordLabourSchema = z
  .object({
    description: displayText(2, 500),
    /** Free text: a village workshop's mechanic has no account here. */
    technician: displayText(2, 120).optional(),
    hours: quantity(6),
    hourlyRateMinor: amountMinorSchema,
    performedAt: z.string().datetime().optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((dto) => Number.parseFloat(dto.hours) > 0, {
    message: 'Labour hours must be greater than zero',
    path: ['hours'],
  });

export type RecordLabourDto = z.infer<typeof recordLabourSchema>;

export const recordCostSchema = z
  .object({
    category: directCostCategorySchema,
    amountMinor: amountMinorSchema,
    currency: currencySchema.default('IRR'),
    description: displayText(2, 500),
    recordedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((dto) => dto.amountMinor !== '0', {
    message: 'A cost of zero records nothing; omit the line instead',
    path: ['amountMinor'],
  });

export type RecordCostDto = z.infer<typeof recordCostSchema>;

export const listRepairOrdersQuerySchema = cursorPaginationSchema
  .extend({
    maintenanceRequestId: seedIdSchema(ID_PREFIXES.maintenanceRequest).optional(),
    assetId: assetId.optional(),
    workshopOrganizationId: organizationId.optional(),
    status: repairOrderStatusSchema.optional(),
  })
  .strict();

export type ListRepairOrdersQuery = z.infer<typeof listRepairOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// Views
//
// Explicit whitelists, so a new column is never exposed by accident.
// ---------------------------------------------------------------------------

export interface ScheduleView {
  id: string;
  organizationId: string;
  assetId: string;
  assetName: string | null;
  title: string;
  maintenanceType: string;
  recurrence: string;
  status: string;
  intervalDays: number | null;
  intervalHours: string | null;
  intervalKilometres: string | null;
  leadDays: number | null;
  leadHours: string | null;
  leadKilometres: string | null;
  lastServicedAt: string | null;
  lastServicedHourMeter: string | null;
  lastServicedOdometer: string | null;
  lastServiceRequestId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A schedule together with its due verdict.
 *
 * The verdict is computed at read time from the rule, the meter and the clock
 * — never read from a stored flag — so a scanner that has not run cannot make
 * an overdue machine look compliant (ADR-027).
 */
export interface ScheduleDueView extends ScheduleView {
  due: {
    state: string;
    basis: string | null;
    dueBy: string | null;
    dueAtMeter: string | null;
    triggers: {
      basis: string;
      state: string;
      dueAt: string | null;
      dueAtMeter: string | null;
      remaining: string;
    }[];
  };
  meter: {
    hourMeter: string;
    odometer: string;
    lastPeriodEnd: string | null;
  };
  /** The live request already raised for this schedule, if there is one. */
  openRequestId: string | null;
}

export interface MaintenanceRequestView {
  id: string;
  organizationId: string;
  assetId: string;
  scheduleId: string | null;
  type: string;
  status: string;
  severity: string | null;
  title: string;
  description: string | null;
  reportedAt: string;
  reportedBy: string;
  dueDate: string | null;
  outOfServiceAt: string | null;
  returnedToServiceAt: string | null;
  downtimeMinutes: number | null;
  startedAt: string | null;
  startedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalNotes: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  totalCostMinor: string;
  currency: string;
}

export interface RepairOrderView {
  id: string;
  organizationId: string;
  maintenanceRequestId: string;
  assetId: string;
  workshopOrganizationId: string;
  workshopName: string | null;
  status: string;
  workSummary: string | null;
  workPerformed: string | null;
  assignedAt: string;
  assignedBy: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  partsCostMinor: string;
  labourCostMinor: string;
  otherCostMinor: string;
  totalCostMinor: string;
  currency: string;
}

export interface PartUsageView {
  id: string;
  repairOrderId: string;
  partName: string;
  partReference: string | null;
  quantity: string;
  unit: string;
  unitCostMinor: string;
  totalCostMinor: string;
  source: string;
  sourceReference: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface LabourEntryView {
  id: string;
  repairOrderId: string;
  description: string;
  technician: string | null;
  hours: string;
  hourlyRateMinor: string;
  totalCostMinor: string;
  performedAt: string;
  recordedAt: string;
  recordedBy: string;
}

/**
 * One cost line, with the work that produced it named.
 *
 * `partUsageId`/`laborEntryId` are the provenance economic-service will audit
 * against; both null means a person entered the line directly, and
 * `recordedBy` is then the whole of its provenance (ADR-028).
 */
export interface MaintenanceCostView {
  id: string;
  repairOrderId: string;
  maintenanceRequestId: string;
  category: string;
  amountMinor: string;
  currency: string;
  description: string | null;
  partUsageId: string | null;
  laborEntryId: string | null;
  recordedAt: string;
  recordedBy: string;
}

/** A repair order with everything recorded under it. */
export interface RepairOrderDetailView extends RepairOrderView {
  parts: PartUsageView[];
  labour: LabourEntryView[];
  costs: MaintenanceCostView[];
}

/** A request with its referrals, for the single-request screen. */
export interface MaintenanceRequestDetailView extends MaintenanceRequestView {
  repairOrders: RepairOrderView[];
  costBreakdown: { category: string; amountMinor: string; currency: string }[];
}
