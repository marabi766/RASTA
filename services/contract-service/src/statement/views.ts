import type { Statement, StatementDeduction, StatementLine } from '../generated/prisma';
import type { StatementView } from './dto';
import type { StatementStateName } from './statement.state-machine';

export type StatementWithParts = Statement & {
  lines: StatementLine[];
  deductions: StatementDeduction[];
};

/**
 * A statement row as a response: money leaves as a decimal string, time as ISO-8601 UTC, the lines
 * in their number order and the deductions in the order of their rules; no person is named.
 */
export function toStatementView(
  row: StatementWithParts,
  contractorOrganizationId: string,
): StatementView {
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
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
