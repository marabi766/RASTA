import type { Contract } from '../generated/prisma';
import type { ContractView } from './dto';
import type { ContractStateName } from './contract.state-machine';

/**
 * Rows to response shapes.
 *
 * Money leaves as a decimal string, never a number (AGENTS.md § 3); time leaves as
 * ISO-8601 UTC.
 */
export function toContractView(row: Contract): ContractView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    tenderId: row.tenderId,
    projectId: row.projectId,
    winningBidId: row.winningBidId,
    contractorOrganizationId: row.contractorOrganizationId,
    amountMinor: row.amountMinor.toString(),
    status: row.status as ContractStateName,
    awardedAt: row.awardedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
