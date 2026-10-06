import type { Amendment } from '../generated/prisma';
import type { SignatureFact } from '../contract/views';
import type { AmendmentView } from './dto';
import type { AmendmentStateName } from './amendment.state-machine';

/**
 * An amendment row as a response: money leaves as a decimal string, time as ISO-8601 UTC, and a
 * party sees that the other side signed and when — not which person did.
 */
export function toAmendmentView(
  row: Amendment,
  signatures: readonly SignatureFact[] = [],
): AmendmentView {
  const signedAt = (side: SignatureFact['side']): string | null =>
    signatures.find((signature) => signature.side === side)?.signedAt.toISOString() ?? null;
  const flagged = signatures.some((signature) => signature.reviewRequired === true);

  return {
    id: row.id,
    contractId: row.contractId,
    organizationId: row.organizationId,
    amendmentNumber: row.amendmentNumber,
    deltaMinor: row.deltaMinor.toString(),
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    status: row.status as AmendmentStateName,
    employerSignedAt: signedAt('EMPLOYER'),
    contractorSignedAt: signedAt('CONTRACTOR'),
    authorityReviewRequired: flagged,
    proposedAt: row.proposedAt.toISOString(),
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
