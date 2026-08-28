import type {
  LabourEntryView,
  MaintenanceCostView,
  MaintenanceRequestView,
  PartUsageView,
  RepairOrderView,
  ScheduleView,
} from './dto';

/**
 * Row-to-view mapping.
 *
 * Explicit whitelists rather than spreading the row, so a column added to the
 * schema is never published by accident — the difference between a considered
 * API and one that leaks whatever the last migration happened to add.
 *
 * Two conversions matter and are done the same way everywhere:
 *
 *   `Decimal.toString()`, never `toNumber()`. The whole reason these columns
 *   are NUMERIC is that a float cannot hold their values exactly, and
 *   converting on the way out would give that up at the last step.
 *
 *   `bigint.toString()`, never `Number(...)`. Money crosses the wire as a
 *   string in minor units (ADR-022), and a rial amount past 9.007e15 does not
 *   survive a JSON number.
 */

interface DecimalLike {
  toString(): string;
}

function decimal(value: DecimalLike | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function minor(value: bigint | null | undefined): string {
  return (value ?? 0n).toString();
}

export interface ScheduleRow {
  id: string;
  organizationId: string;
  assetId: string;
  title: string;
  maintenanceType: string;
  recurrence: string;
  status: string;
  intervalDays: number | null;
  intervalHours: DecimalLike | null;
  intervalKilometres: DecimalLike | null;
  leadDays: number | null;
  leadHours: DecimalLike | null;
  leadKilometres: DecimalLike | null;
  lastServicedAt: Date | null;
  lastServicedHourMeter: DecimalLike | null;
  lastServicedOdometer: DecimalLike | null;
  lastServiceRequestId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toScheduleView(row: ScheduleRow, assetName: string | null = null): ScheduleView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    assetId: row.assetId,
    assetName,
    title: row.title,
    maintenanceType: row.maintenanceType,
    recurrence: row.recurrence,
    status: row.status,
    intervalDays: row.intervalDays,
    intervalHours: decimal(row.intervalHours),
    intervalKilometres: decimal(row.intervalKilometres),
    leadDays: row.leadDays,
    leadHours: decimal(row.leadHours),
    leadKilometres: decimal(row.leadKilometres),
    lastServicedAt: row.lastServicedAt?.toISOString() ?? null,
    lastServicedHourMeter: decimal(row.lastServicedHourMeter),
    lastServicedOdometer: decimal(row.lastServicedOdometer),
    lastServiceRequestId: row.lastServiceRequestId,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface RequestRow {
  id: string;
  organizationId: string;
  assetId: string;
  scheduleId: string | null;
  type: string;
  status: string;
  severity: string | null;
  title: string;
  description: string | null;
  reportedAt: Date;
  reportedBy: string;
  dueDate: Date | null;
  outOfServiceAt: Date | null;
  returnedToServiceAt: Date | null;
  downtimeMinutes: number | null;
  startedAt: Date | null;
  startedBy: string | null;
  completedAt: Date | null;
  completedBy: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  approvalNotes: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  totalCostMinor: bigint;
  currency: string;
}

export function toRequestView(row: RequestRow): MaintenanceRequestView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    assetId: row.assetId,
    scheduleId: row.scheduleId,
    type: row.type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    description: row.description,
    reportedAt: row.reportedAt.toISOString(),
    reportedBy: row.reportedBy,
    dueDate: row.dueDate?.toISOString() ?? null,
    outOfServiceAt: row.outOfServiceAt?.toISOString() ?? null,
    returnedToServiceAt: row.returnedToServiceAt?.toISOString() ?? null,
    downtimeMinutes: row.downtimeMinutes,
    startedAt: row.startedAt?.toISOString() ?? null,
    startedBy: row.startedBy,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedBy: row.completedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvalNotes: row.approvalNotes,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    totalCostMinor: minor(row.totalCostMinor),
    currency: row.currency,
  };
}

export interface RepairOrderRow {
  id: string;
  organizationId: string;
  maintenanceRequestId: string;
  assetId: string;
  workshopOrganizationId: string;
  workshopName: string | null;
  status: string;
  workSummary: string | null;
  workPerformed: string | null;
  assignedAt: Date;
  assignedBy: string;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  partsCostMinor: bigint;
  labourCostMinor: bigint;
  otherCostMinor: bigint;
  totalCostMinor: bigint;
  currency: string;
}

export function toRepairOrderView(row: RepairOrderRow): RepairOrderView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    maintenanceRequestId: row.maintenanceRequestId,
    assetId: row.assetId,
    workshopOrganizationId: row.workshopOrganizationId,
    workshopName: row.workshopName,
    status: row.status,
    workSummary: row.workSummary,
    workPerformed: row.workPerformed,
    assignedAt: row.assignedAt.toISOString(),
    assignedBy: row.assignedBy,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    partsCostMinor: minor(row.partsCostMinor),
    labourCostMinor: minor(row.labourCostMinor),
    otherCostMinor: minor(row.otherCostMinor),
    totalCostMinor: minor(row.totalCostMinor),
    currency: row.currency,
  };
}

export interface PartRow {
  id: string;
  repairOrderId: string;
  partName: string;
  partReference: string | null;
  quantity: DecimalLike;
  unit: string;
  unitCostMinor: bigint;
  totalCostMinor: bigint;
  source: string;
  sourceReference: string | null;
  recordedAt: Date;
  recordedBy: string;
}

export function toPartView(row: PartRow): PartUsageView {
  return {
    id: row.id,
    repairOrderId: row.repairOrderId,
    partName: row.partName,
    partReference: row.partReference,
    quantity: row.quantity.toString(),
    unit: row.unit,
    unitCostMinor: minor(row.unitCostMinor),
    totalCostMinor: minor(row.totalCostMinor),
    source: row.source,
    sourceReference: row.sourceReference,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
  };
}

export interface LabourRow {
  id: string;
  repairOrderId: string;
  description: string;
  technician: string | null;
  hours: DecimalLike;
  hourlyRateMinor: bigint;
  totalCostMinor: bigint;
  performedAt: Date;
  recordedAt: Date;
  recordedBy: string;
}

export function toLabourView(row: LabourRow): LabourEntryView {
  return {
    id: row.id,
    repairOrderId: row.repairOrderId,
    description: row.description,
    technician: row.technician,
    hours: row.hours.toString(),
    hourlyRateMinor: minor(row.hourlyRateMinor),
    totalCostMinor: minor(row.totalCostMinor),
    performedAt: row.performedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
  };
}

export interface CostRow {
  id: string;
  repairOrderId: string;
  maintenanceRequestId: string;
  category: string;
  amountMinor: bigint;
  currency: string;
  description: string | null;
  partUsageId: string | null;
  laborEntryId: string | null;
  recordedAt: Date;
  recordedBy: string;
}

export function toCostView(row: CostRow): MaintenanceCostView {
  return {
    id: row.id,
    repairOrderId: row.repairOrderId,
    maintenanceRequestId: row.maintenanceRequestId,
    category: row.category,
    amountMinor: minor(row.amountMinor),
    currency: row.currency,
    description: row.description,
    partUsageId: row.partUsageId,
    laborEntryId: row.laborEntryId,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
  };
}
