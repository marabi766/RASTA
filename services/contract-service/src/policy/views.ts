import type { PolicyAuthorRole } from './policy.access';
import type { PolicyWithSteps } from './policy.repository';
import type { PolicyStateName, WorkflowKey } from './policy.state-machine';
import type { PolicyView } from './dto';

/** Rows to response shapes. Time as ISO-8601 UTC. */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function toPolicyView(row: PolicyWithSteps): PolicyView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    authorOrganizationId: row.authorOrganizationId,
    authorRole: row.authorRole as PolicyAuthorRole,
    workflowKey: row.workflowKey as WorkflowKey,
    policyVersion: row.policyVersion,
    status: row.status as PolicyStateName,
    label: row.label,
    rationale: row.rationale,
    isSample: row.isSample,
    steps: row.steps.map((step) => ({
      stepOrder: step.stepOrder,
      authorityOrganizationId: step.authorityOrganizationId,
      authorityRole: step.authorityRole,
      authorityLabel: step.authorityLabel,
    })),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    submittedAt: iso(row.submittedAt),
    submittedBy: row.submittedBy,
    activatedAt: iso(row.activatedAt),
    activatedBy: row.activatedBy,
    rejectedAt: iso(row.rejectedAt),
    rejectedBy: row.rejectedBy,
    rejectionReason: row.rejectionReason,
    retiredAt: iso(row.retiredAt),
    retiredBy: row.retiredBy,
    version: row.version,
  };
}
