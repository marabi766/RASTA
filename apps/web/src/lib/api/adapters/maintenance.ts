import { z } from 'zod';
import { amountMinorSchema, currencySchema } from '@rasta/contracts';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * Service schedules, maintenance requests and repair orders.
 *
 * `GET /v1/maintenance-schedules/due` is the one to show. The due verdict is
 * **computed on every call** from the machine's current meter and the clock —
 * never read from a stored flag — so a background scan that has not run cannot
 * make an overdue machine look compliant. Each entry names which trigger came
 * due (time, hours or kilometres) and how much is left, and the UI renders that
 * attribution rather than a single "overdue" word.
 *
 * Costs are rial strings throughout and are never summed in the browser.
 * `totalCostMinor` is what the service computed under a row lock; recomputing
 * it here from parts and labour would be a second, weaker arithmetic that could
 * disagree with the ledger (ADR-028).
 *
 * Shapes read from `services/maintenance-service/src/maintenance/dto.ts`.
 */

export const MAINTENANCE_ADAPTER = {
  id: 'maintenance.operations',
  service: 'maintenance-service',
  routes: [
    'GET /v1/maintenance-schedules/due',
    'GET /v1/maintenance-requests',
    'GET /v1/maintenance-requests/{id}',
    'GET /v1/repair-orders',
  ],
} as const satisfies AdapterDescriptor;

const dueTriggerSchema = z.object({
  basis: z.string(),
  state: z.string(),
  dueAt: z.string().nullable(),
  dueAtMeter: z.string().nullable(),
  remaining: z.string(),
});

export const scheduleDueSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  assetId: z.string(),
  assetName: z.string().nullable(),
  title: z.string(),
  maintenanceType: z.string(),
  recurrence: z.string(),
  status: z.string(),
  intervalDays: z.number().int().nullable(),
  intervalHours: z.string().nullable(),
  intervalKilometres: z.string().nullable(),
  leadDays: z.number().int().nullable(),
  leadHours: z.string().nullable(),
  leadKilometres: z.string().nullable(),
  lastServicedAt: z.string().nullable(),
  lastServicedHourMeter: z.string().nullable(),
  lastServicedOdometer: z.string().nullable(),
  lastServiceRequestId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  due: z.object({
    state: z.string(),
    basis: z.string().nullable(),
    dueBy: z.string().nullable(),
    dueAtMeter: z.string().nullable(),
    triggers: z.array(dueTriggerSchema),
  }),
  meter: z.object({
    hourMeter: z.string(),
    odometer: z.string(),
    lastPeriodEnd: z.string().nullable(),
  }),
  /** The live request already raised for this schedule, if there is one. */
  openRequestId: z.string().nullable(),
});

export type ScheduleDue = z.infer<typeof scheduleDueSchema>;

/** `DUE_STATES` from `maintenance/due.ts`. Three values, no more. */
export const DUE_STATE_LABELS: Record<string, string> = {
  OVERDUE: 'گذشته از موعد',
  DUE_SOON: 'نزدیک سررسید',
  NOT_DUE: 'سررسید نشده',
};

export const DUE_BASIS_LABELS: Record<string, string> = {
  TIME: 'زمان',
  HOURS: 'ساعت کارکرد',
  KILOMETRES: 'کیلومتر',
};

export const maintenanceRequestSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  assetId: z.string(),
  scheduleId: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  severity: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  reportedAt: z.string(),
  reportedBy: z.string(),
  dueDate: z.string().nullable(),
  outOfServiceAt: z.string().nullable(),
  returnedToServiceAt: z.string().nullable(),
  downtimeMinutes: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  startedBy: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvalNotes: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  totalCostMinor: amountMinorSchema,
  currency: currencySchema,
});

export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

export const repairOrderSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  maintenanceRequestId: z.string(),
  assetId: z.string(),
  workshopOrganizationId: z.string(),
  workshopName: z.string().nullable(),
  status: z.string(),
  workSummary: z.string().nullable(),
  workPerformed: z.string().nullable(),
  assignedAt: z.string(),
  assignedBy: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  partsCostMinor: amountMinorSchema,
  labourCostMinor: amountMinorSchema,
  otherCostMinor: amountMinorSchema,
  totalCostMinor: amountMinorSchema,
  currency: currencySchema,
});

export type RepairOrder = z.infer<typeof repairOrderSchema>;

export const maintenanceRequestDetailSchema = maintenanceRequestSchema.extend({
  repairOrders: z.array(repairOrderSchema),
  costBreakdown: z.array(
    z.object({
      category: z.string(),
      amountMinor: amountMinorSchema,
      currency: currencySchema,
    }),
  ),
});

export type MaintenanceRequestDetail = z.infer<typeof maintenanceRequestDetailSchema>;

/** `REQUEST_STATUS_VALUES` from the service. */
export const REQUEST_STATUS_LABELS: Record<string, string> = {
  OPEN: 'باز',
  IN_PROGRESS: 'در حال انجام',
  COMPLETED: 'انجام‌شده',
  APPROVED: 'تأییدشده',
  CANCELLED: 'لغوشده',
};

/** `REPAIR_ORDER_STATUS_VALUES` from the service. */
export const REPAIR_ORDER_STATUS_LABELS: Record<string, string> = {
  OPEN: 'باز',
  IN_PROGRESS: 'در حال انجام',
  COMPLETED: 'انجام‌شده',
  CANCELLED: 'لغوشده',
};

/** `MAINTENANCE_TYPES` — preventive versus corrective. */
export const MAINTENANCE_TYPE_LABELS: Record<string, string> = {
  PREVENTIVE: 'پیشگیرانه',
  CORRECTIVE: 'اصلاحی',
};

export const SEVERITY_LABELS: Record<string, string> = {
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  CRITICAL: 'بحرانی',
};

const cursorPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() });

export async function listDueSchedules(
  client: ApiClient,
  options: { includeNotDue?: boolean; assetId?: string } = {},
  signal?: AbortSignal,
): Promise<ScheduleDue[]> {
  const result = await client.request({
    path: '/v1/maintenance-schedules/due',
    schema: cursorPage(scheduleDueSchema),
    signal,
    query: {
      assetId: options.assetId,
      includeNotDue:
        options.includeNotDue === undefined ? undefined : String(options.includeNotDue),
      limit: 50,
    },
  });

  return result.data.items;
}

export async function listMaintenanceRequests(
  client: ApiClient,
  options: { assetId?: string; openOnly?: boolean } = {},
  signal?: AbortSignal,
): Promise<MaintenanceRequest[]> {
  const result = await client.request({
    path: '/v1/maintenance-requests',
    schema: cursorPage(maintenanceRequestSchema),
    signal,
    query: {
      assetId: options.assetId,
      openOnly: options.openOnly === undefined ? undefined : String(options.openOnly),
      limit: 50,
    },
  });

  return result.data.items;
}

export async function fetchMaintenanceRequest(
  client: ApiClient,
  requestId: string,
  signal?: AbortSignal,
): Promise<MaintenanceRequestDetail> {
  const result = await client.request({
    path: `/v1/maintenance-requests/${encodeURIComponent(requestId)}`,
    schema: maintenanceRequestDetailSchema,
    signal,
  });

  return result.data;
}

export async function listRepairOrders(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<RepairOrder[]> {
  const result = await client.request({
    path: '/v1/repair-orders',
    schema: cursorPage(repairOrderSchema),
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}
