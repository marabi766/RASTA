import type { Contract } from '../generated/prisma';
import type { ContractView } from './dto';
import type { ContractStateName } from './contract.state-machine';

/** What a view shows of a signature: which side accepted, and when — never who. */
export interface SignatureFact {
  readonly side: 'EMPLOYER' | 'CONTRACTOR';
  readonly signedAt: Date;
}

/**
 * Rows to response shapes.
 *
 * Money leaves as a decimal string, never a number (AGENTS.md § 3); time leaves as
 * ISO-8601 UTC. A party sees that the other side accepted and when, not which person did:
 * the signer's identity stays in the signature record and on the audit event.
 */
export function toContractView(
  row: Contract,
  signatures: readonly SignatureFact[] = [],
): ContractView {
  const signedAt = (side: SignatureFact['side']): string | null =>
    signatures.find((signature) => signature.side === side)?.signedAt.toISOString() ?? null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    tenderId: row.tenderId,
    projectId: row.projectId,
    winningBidId: row.winningBidId,
    contractorOrganizationId: row.contractorOrganizationId,
    amountMinor: row.amountMinor.toString(),
    status: row.status as ContractStateName,
    employerSignedAt: signedAt('EMPLOYER'),
    contractorSignedAt: signedAt('CONTRACTOR'),
    cancelReasonCode: row.cancelReasonCode,
    cancelNote: row.cancelNote,
    awardedAt: row.awardedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
