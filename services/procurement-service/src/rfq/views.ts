import type { RfqCriterion, RfqInvitation } from '../generated/prisma';
import type { RfqStateName } from './rfq.state-machine';
import type { Criterion, RfqView } from './dto';
import type { RfqRecord } from './rfq.repository';

/** Which side reads an RFQ: what the view shows follows from it (ADR-070 § 10). */
export type RfqSide = 'BUYER' | 'SUPPLIER';

export function toCriterionView(row: RfqCriterion): Criterion {
  return {
    code: row.code,
    label: row.label,
    weightBp: row.weightBp,
    scoringMethod: row.scoringMethod as Criterion['scoringMethod'],
    maxScore: row.maxScore,
  };
}

/**
 * The RFQ as `side` reads it. The buyer sees whom it invited and why it cancelled; an invited
 * supplier sees what it is asked to quote for — the product, the total quantity, the criteria and
 * the deadline — never the other invitees, nor who registered the demands.
 */
export function toRfqView(record: RfqRecord, side: RfqSide): RfqView {
  const { rfq } = record;
  const view: RfqView = {
    id: rfq.id,
    organizationId: rfq.organizationId,
    aggregationId: rfq.aggregationId,
    productId: rfq.productId,
    totalQuantity: rfq.totalQuantity,
    status: rfq.status as RfqStateName,
    procurementNature: rfq.procurementNature as RfqView['procurementNature'],
    quotationClosingAt: rfq.quotationClosingAt.toISOString(),
    criteria: record.criteria.map(toCriterionView),
    criteriaDigest: rfq.criteriaDigest,
    issuedAt: rfq.issuedAt.toISOString(),
    closedAt: rfq.closedAt?.toISOString() ?? null,
    cancelledAt: rfq.cancelledAt?.toISOString() ?? null,
    cancelReasonCode: (rfq.cancelReasonCode as RfqView['cancelReasonCode']) ?? null,
    version: rfq.version,
  };
  if (side === 'SUPPLIER') return view;
  return {
    ...view,
    invitedSupplierOrganizationIds: invitedIds(record.invitations ?? []),
    cancelReason: rfq.cancelReason ?? null,
  };
}

function invitedIds(invitations: readonly RfqInvitation[]): string[] {
  return invitations.map((invitation) => invitation.supplierOrganizationId);
}
