import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * Drivers, assignments, usage and dispatchability, from `fleet-service`.
 *
 * The interesting endpoint is `GET /v1/fleet/availability`, and the reason is
 * in its own contract: it composes facts owned by four different services and
 * **names the owner of every blocker**. An operator told only "unavailable"
 * cannot know whether to call the workshop, renew a policy or end an
 * assignment; that attribution is the feature, so the UI renders every blocker
 * with its owning service rather than collapsing them into one word.
 *
 * `utilizationPercent` is `null` — never `0` — when a window holds no readings.
 * "We have no data" and "the machine sat idle" are different facts, and
 * reporting the first as the second is precisely how a dashboard invents data
 * (docs/04 § 4.15). It is rendered as «داده‌ای ثبت نشده», never as zero.
 *
 * Shapes read from `services/fleet-service/src/fleet/dto.ts`.
 */

export const FLEET_ADAPTER = {
  id: 'fleet.operations',
  service: 'fleet-service',
  routes: [
    'GET /v1/fleet/availability',
    'GET /v1/fleet/utilization',
    'GET /v1/drivers',
    'GET /v1/assignments',
    'GET /v1/usage-records',
  ],
} as const satisfies AdapterDescriptor;

const availabilityBlockerSchema = z.object({
  code: z.string(),
  /** Which service owns the fact behind this blocker. */
  owner: z.string(),
  detail: z.string(),
});

export const availabilityViewSchema = z.object({
  assetId: z.string(),
  assetName: z.string().nullable(),
  assetType: z.string().nullable(),
  assetTag: z.string().nullable(),
  available: z.boolean(),
  blockers: z.array(availabilityBlockerSchema),
  currentAssignment: z
    .object({ id: z.string(), driverId: z.string(), startedAt: z.string() })
    .nullable(),
});

export type AvailabilityView = z.infer<typeof availabilityViewSchema>;

export const BLOCKER_LABELS: Record<string, string> = {
  ASSET_STATUS: 'وضعیت دارایی',
  IN_MAINTENANCE: 'در تعمیرگاه',
  DISPATCH_BLOCKED: 'ممنوعیت اعزام',
  ACTIVE_ASSIGNMENT: 'تخصیص فعال',
  DECLARED_UNAVAILABLE: 'اعلام عدم دسترسی',
};

export const utilizationViewSchema = z.object({
  assetId: z.string(),
  assetName: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  usedHours: z.string(),
  kilometres: z.string(),
  availableHours: z.string(),
  /** Null, never zero, when the window holds no readings at all. */
  utilizationPercent: z.string().nullable(),
  recordCount: z.number().int(),
  assignmentCount: z.number().int(),
});

export type UtilizationView = z.infer<typeof utilizationViewSchema>;

export const driverViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  employeeNo: z.string().nullable(),
  licenceNumber: z.string().nullable(),
  licenceClass: z.string().nullable(),
  licenceValidTo: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DriverView = z.infer<typeof driverViewSchema>;

export const assignmentViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  driverId: z.string(),
  assetId: z.string(),
  active: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  purpose: z.string().nullable(),
  endReason: z.string().nullable(),
  endNotes: z.string().nullable(),
  assignedBy: z.string(),
  endedBy: z.string().nullable(),
});

export type AssignmentView = z.infer<typeof assignmentViewSchema>;

export const usageRecordSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  assetId: z.string(),
  driverId: z.string().nullable(),
  assignmentId: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** Decimal strings, so a meter reading never loses precision in a parser. */
  hours: z.string().nullable(),
  kilometres: z.string().nullable(),
  hourMeter: z.string().nullable(),
  odometer: z.string().nullable(),
  source: z.string(),
  notes: z.string().nullable(),
  clientReference: z.string().nullable(),
  recordedAt: z.string(),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

const cursorPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() });

export async function listAvailability(
  client: ApiClient,
  options: { assetId?: string; availableOnly?: boolean } = {},
  signal?: AbortSignal,
): Promise<AvailabilityView[]> {
  const result = await client.request({
    path: '/v1/fleet/availability',
    schema: cursorPage(availabilityViewSchema),
    signal,
    query: {
      assetId: options.assetId,
      // The service parses this as the literal string, deliberately: a
      // `z.coerce.boolean()` would read "false" as true (D-023).
      availableOnly:
        options.availableOnly === undefined ? undefined : String(options.availableOnly),
      limit: 50,
    },
  });

  return result.data.items;
}

export async function listUtilization(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<UtilizationView[]> {
  const result = await client.request({
    path: '/v1/fleet/utilization',
    schema: z.object({ items: z.array(utilizationViewSchema), from: z.string(), to: z.string() }),
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}

export async function listDrivers(client: ApiClient, signal?: AbortSignal): Promise<DriverView[]> {
  const result = await client.request({
    path: '/v1/drivers',
    schema: cursorPage(driverViewSchema),
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}

export async function listAssignments(
  client: ApiClient,
  options: { assetId?: string; active?: boolean } = {},
  signal?: AbortSignal,
): Promise<AssignmentView[]> {
  const result = await client.request({
    path: '/v1/assignments',
    schema: cursorPage(assignmentViewSchema),
    signal,
    query: {
      assetId: options.assetId,
      active: options.active === undefined ? undefined : String(options.active),
      limit: 50,
    },
  });

  return result.data.items;
}

export async function listUsageRecords(
  client: ApiClient,
  options: { assetId?: string } = {},
  signal?: AbortSignal,
): Promise<UsageRecord[]> {
  const result = await client.request({
    path: '/v1/usage-records',
    schema: cursorPage(usageRecordSchema),
    signal,
    query: { assetId: options.assetId, limit: 50 },
  });

  return result.data.items;
}
