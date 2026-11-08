/** D-119 staged rollout: these exact owning relations retain the pre-F1 behaviour.
 * No wildcard: a new relation is UNCLASSIFIED, including in a legacy family.
 * Remove each family in its separately reviewed follow-up. */
const listed = (relations: string): readonly string[] => relations.trim().split(/\s+/);

export const LEGACY_SCALAR_RELATIONS = {
  analytics: [],
  asset: listed(`
    AssetTransfer.asset AssetLocation.asset AssetDocumentRef.asset
    InsurancePolicy.asset InsuranceClaim.policy InsuranceClaimDocument.claim
    TechnicalInspection.asset AssetTimelineEntry.asset
  `),
  construction: listed(`
    ProjectNeed.project PolicyReconciliationTask.policy ApprovalPolicyStep.policy
    Approval.project Approval.policy Approval.tender
    ProgressReport.project Tender.project TenderInvitation.tender
    TenderKey.tender TenderCriterion.tender Bid.tender
    BidReceipt.tender BidAccessLog.tender BidQualification.tender
    BidEvaluation.tender BidEvaluationRecusal.tender BidEvaluationScore.tender
    BidEvaluationScore.evaluation TenderAward.tender TenderAward.bid
    TenderAwardStandingCheck.tender TenderApprovalRequest.tender TenderApprovalLog.tender
  `),
  contract: listed(`
    ContractSignature.contract ContractSignature.policy SignatureAuthorityReview.signature
    SignatureAuthorityReview.policy Amendment.contract AmendmentSignature.contract
    AmendmentSignature.amendment AmendmentSignature.policy AmendmentSignatureReview.signature
    AmendmentSignatureReview.policy Milestone.contract Statement.contract
    StatementLine.statement StatementLine.milestone StatementDeduction.statement
    StatementDeduction.rule StatementApprovalStep.statement StatementApprovalStep.policy
    StatementDecision.statement StatementDecision.step PolicyReconciliationTask.policy
    ApprovalPolicyStep.policy
  `),
  document: listed(`
    AccessGrant.document
  `),
  economic: listed(`
    Journal.reverses LedgerEntry.journal LedgerEntry.account
    Wallet.account WalletHold.wallet Transaction.pricingRule
    TransactionSourceQuarantine.transaction TransactionLeg.transaction PaymentRefundDecline.paymentIntent
    PaymentReconciliationTask.paymentIntent PaymentReconciliationResolution.task PaymentReconciliationResolution.paymentIntent
    PaymentReconciliationRequeue.task PaymentReconciliationRequeue.paymentIntent Commission.transaction
    Commission.rule RewardRuleStatusHistory.rule Reward.rule
    RewardBalance.level Settlement.transaction
  `),
  fleet: listed(`
    Assignment.driver UsageRecord.driver UsageRecord.assignment
  `),
  identity: listed(`
    Membership.user RolePermission.role RolePermission.permission
    RegistrationRequest.user
  `),
  inventory: [],
  maintenance: listed(`
    MaintenanceRequest.schedule RepairOrder.request PartUsage.repairOrder
    LaborEntry.repairOrder MaintenanceCost.repairOrder MaintenanceCost.request
    MaintenanceCost.part MaintenanceCost.labour
  `),
  notification: listed(`
    RecipientResolution.intent NotificationDelivery.intent DeliveryAttempt.delivery
    InAppNotification.delivery InAppNotification.intent NotificationTemplateVersion.template
  `),
  procurement: [],
  supplier: listed(`
    SupplierCapability.supplier Qualification.supplier QualificationEvidence.qualification
    Suspension.supplier PerformanceFormulaWeight.formulaVersion PerformanceEvent.compensates
    PerformanceScoreSnapshot.formula PerformanceScoreComponent.snapshot PerformanceScoreSourceEvent.snapshot
    PerformanceScoreSourceEvent.event
  `),
} as const;

export type ScalarFkFamily = keyof typeof LEGACY_SCALAR_RELATIONS | 'marketplace';
export type ScalarRelationPolicy =
  | 'SAME_TENANT'
  | 'CROSS_PARTY_REVIEWED'
  | 'PROTECTED_BY_COMPOSITE_FK'
  | 'LEGACY_PASS_THROUGH'
  | 'UNCLASSIFIED';

// Cross-party exceptions name both the link and its domain reason.
const CROSS_PARTY_REVIEWED: Readonly<Record<string, string>> = {
  'Offer.product': 'ADR-037/042: suppliers offer products from the shared catalogue.',
  'OrderLine.offer': 'ADR-037: buyer-owned lines reference the supplier-owned offer purchased.',
};
const SAME_TENANT = new Set(
  listed(`
  OfferPriceHistory.offer OrderLine.order Fulfillment.order OrderStatusHistory.order
  SagaStep.order SagaUnconfirmedCall.order OrderDispute.order Review.order
  OrderHoldDeadlineBackfill.order
`),
);
// RUN-005 migrations already enforce (organization_id, return_request_id).
const PROTECTED_BY_COMPOSITE_FK = new Set(
  listed(`
  ReturnLine.returnRequest ReturnStatusHistory.returnRequest ReturnDispatchRelease.returnRequest
`),
);

export function scalarRelationPolicy(
  family: ScalarFkFamily | undefined,
  relation: string,
): ScalarRelationPolicy {
  if (family === 'marketplace') {
    if (Object.hasOwn(CROSS_PARTY_REVIEWED, relation)) return 'CROSS_PARTY_REVIEWED';
    if (SAME_TENANT.has(relation)) return 'SAME_TENANT';
    if (PROTECTED_BY_COMPOSITE_FK.has(relation)) return 'PROTECTED_BY_COMPOSITE_FK';
    return 'UNCLASSIFIED';
  }
  if (family && (LEGACY_SCALAR_RELATIONS[family] as readonly string[]).includes(relation))
    return 'LEGACY_PASS_THROUGH';
  return 'UNCLASSIFIED';
}
