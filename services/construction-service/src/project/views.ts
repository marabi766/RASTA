import type { Project, ProjectNeed } from '../generated/prisma';
import type { NeedView, ProjectSummaryView, ProjectView } from './dto';
import type { NeedsSummary } from './project.repository';
import type { ProjectStateName } from './project.state-machine';
import type { NeedStateName } from './need.state-machine';

/**
 * Rows to response shapes.
 *
 * Money leaves as a decimal string, never a number (AGENTS.md § 3); a quantity
 * leaves in plain decimal notation (`toFixed()` never switches to exponent
 * form, which `toString()` may); time leaves as ISO-8601 UTC.
 */

export function toProjectSummaryView(row: Project, hasArea: boolean): ProjectSummaryView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    operationType: row.operationType,
    locationDescription: row.locationDescription,
    hasArea,
    estimatedCostMinor: row.estimatedCostMinor === null ? null : row.estimatedCostMinor.toString(),
    status: row.status as ProjectStateName,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt.toISOString(),
    statusChangedBy: row.statusChangedBy,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    version: row.version,
  };
}

export function toProjectView(
  row: Project,
  area: unknown,
  needsSummary: NeedsSummary,
): ProjectView {
  return {
    ...toProjectSummaryView(row, area !== null),
    scopeOfWork: row.scopeOfWork,
    area: area as ProjectView['area'],
    needsSummary,
  };
}

export function toNeedView(row: ProjectNeed): NeedView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    quantity: row.quantity === null ? null : row.quantity.toFixed(),
    unit: row.unit,
    estimatedCostMinor: row.estimatedCostMinor === null ? null : row.estimatedCostMinor.toString(),
    status: row.status as NeedStateName,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submittedBy: row.submittedBy,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    withdrawnBy: row.withdrawnBy,
    withdrawalReason: row.withdrawalReason,
    version: row.version,
  };
}
