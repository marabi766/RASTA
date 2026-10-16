import type {
  Statement,
  StatementApprovalStep,
  StatementDeduction,
  StatementLine,
} from '../generated/prisma';
import type { StatementChain } from '../policy/policy.state-machine';
import type { StatementView } from './dto';
import type { StatementStateName } from './statement.state-machine';

export type StatementWithParts = Statement & {
  lines: StatementLine[];
  deductions: StatementDeduction[];
  approvalSteps: StatementApprovalStep[];
};

type ChainView = NonNullable<StatementView['approvalChains']>['technical'];

/** One chain's snapshot rows, in step order; null when the statement has none (a draft). */
function chainView(
  steps: readonly StatementApprovalStep[],
  chain: StatementChain,
): ChainView | null {
  const own = steps
    .filter((step) => step.chain === chain)
    .sort((a, b) => a.stepOrder - b.stepOrder);
  const [first] = own;
  if (!first) return null;
  return {
    policyId: first.policyId,
    policyVersion: first.policyVersion,
    steps: own.map((step) => ({
      stepOrder: step.stepOrder,
      authorityOrganizationId: step.authorityOrganizationId,
      authorityRole: step.authorityRole,
      authorityLabel: step.authorityLabel,
    })),
  };
}

/**
 * A statement row as a response: money leaves as a decimal string, time as ISO-8601 UTC, the lines
 * in their number order and the deductions in the order of their rules, and the approval chains as
 * they were snapshotted at submission; no person is named.
 */
export function toStatementView(
  row: StatementWithParts,
  contractorOrganizationId: string,
): StatementView {
  const technical = chainView(row.approvalSteps, 'TECHNICAL');
  const financial = chainView(row.approvalSteps, 'FINANCIAL');
  return {
    id: row.id,
    contractId: row.contractId,
    organizationId: row.organizationId,
    contractorOrganizationId,
    statementNumber: row.statementNumber,
    status: row.status as StatementStateName,
    grossMinor: row.grossMinor.toString(),
    deductionsMinor: row.deductionsMinor.toString(),
    netMinor: row.netMinor.toString(),
    lines: [...row.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        lineNumber: line.lineNumber,
        description: line.description,
        amountMinor: line.amountMinor.toString(),
        milestoneId: line.milestoneId,
      })),
    deductions: [...row.deductions]
      .sort((a, b) => (a.deductionRuleId < b.deductionRuleId ? -1 : 1))
      .map((deduction) => ({
        deductionRuleId: deduction.deductionRuleId,
        name: deduction.name,
        rateBp: deduction.rateBp,
        base: deduction.base as 'GROSS',
        amountMinor: deduction.amountMinor.toString(),
      })),
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    // Both or neither: the database never holds a submitted statement without both chains.
    approvalChains: technical && financial ? { technical, financial } : null,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
