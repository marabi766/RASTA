import type { Approval } from '../generated/prisma';
import type { ApprovalView, PolicyView } from './dto';
import type { PolicyWithSteps, ProjectBrief } from './approval.repository';
import type { ApprovalStateName, PolicyStateName, WorkflowKey } from './approval.state-machine';

/** Rows to response shapes. Money as decimal strings, time as ISO-8601 UTC. */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const amount = (value: bigint | null): string | null => (value === null ? null : value.toString());

export function toPolicyView(row: PolicyWithSteps): PolicyView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workflowKey: row.workflowKey as WorkflowKey,
    policyVersion: row.policyVersion,
    status: row.status as PolicyStateName,
    label: row.label,
    rationale: row.rationale,
    isSample: row.isSample,
    steps: row.steps.map((step) => ({
      stepOrder: step.stepOrder,
      approvalType: step.approvalType,
      authorityOrganizationId: step.authorityOrganizationId,
      authorityRole: step.authorityRole,
      authorityLabel: step.authorityLabel,
      minAmountMinor: amount(step.minAmountMinor),
      maxAmountMinor: amount(step.maxAmountMinor),
    })),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    activatedAt: iso(row.activatedAt),
    activatedBy: row.activatedBy,
    retiredAt: iso(row.retiredAt),
    retiredBy: row.retiredBy,
    version: row.version,
  };
}

export function toApprovalView(row: Approval, project: ProjectBrief): ApprovalView {
  return {
    id: row.id,
    projectId: row.projectId,
    projectOrganizationId: row.organizationId,
    workflowKey: row.workflowKey as WorkflowKey,
    round: row.round,
    stepOrder: row.stepOrder,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    approvalType: row.approvalType,
    authorityOrganizationId: row.authorityOrganizationId,
    authorityRole: row.authorityRole,
    authorityLabel: row.authorityLabel,
    status: row.status as ApprovalStateName,
    requestedAt: iso(row.requestedAt),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionNumber: row.decisionNumber,
    conditions: row.conditions,
    reason: row.reason,
    supersededAt: iso(row.supersededAt),
    version: row.version,
    project: {
      title: project.title,
      operationType: project.operationType,
      estimatedCostMinor: amount(project.estimatedCostMinor),
      status: project.status,
    },
  };
}
