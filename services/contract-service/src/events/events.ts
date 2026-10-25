import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';
import { WORKFLOW_KEYS } from '../policy/policy.state-machine';

/**
 * Events published by contract-service, on `rasta.contract.v1`.
 *
 * `CONTRACT_DRAFTED` is the one event of CON-003 PR 1: the draft a tender award
 * created. The catalogue (`docs/04` § 4.13) named `CONTRACT_CREATED` with an
 * `amount`; ADR-068 § 4 defines `CONTRACT_DRAFTED` in its place, without the amount
 * (the project manager names it and accepts the change).
 *
 * The payloads are defined here because this service owns them (ADR-032); the
 * only cross-service contract in `packages/contracts` is the audit trail.
 *
 * ## What these payloads never carry
 *
 * **Identifiers and instants only — no amount, no free text, no personal data.**
 * The topic is read by every service that declares a subscription, and by
 * audit-service in full (`docs/07` § 7.3). The contract's price is the winner's bid
 * price, which `TENDER_AWARDED` itself does not carry (round 1 of #199); a consumer
 * that needs it asks this service's API under its own authorization.
 */

export const CONTRACT_EVENTS = {
  CONTRACT_DRAFTED: 'CONTRACT_DRAFTED',
  CONTRACT_SIGNATURE_RECORDED: 'CONTRACT_SIGNATURE_RECORDED',
  CONTRACT_SIGNED: 'CONTRACT_SIGNED',
  CONTRACT_CANCELLED: 'CONTRACT_CANCELLED',
  APPROVAL_POLICY_CREATED: 'APPROVAL_POLICY_CREATED',
  APPROVAL_POLICY_SUBMITTED: 'APPROVAL_POLICY_SUBMITTED',
  APPROVAL_POLICY_REJECTED: 'APPROVAL_POLICY_REJECTED',
  APPROVAL_POLICY_ACTIVATED: 'APPROVAL_POLICY_ACTIVATED',
  APPROVAL_POLICY_RETIRED: 'APPROVAL_POLICY_RETIRED',
  APPROVAL_POLICY_SUSPENDED: 'APPROVAL_POLICY_SUSPENDED',
  APPROVAL_POLICY_APPROVAL_REFUSED: 'APPROVAL_POLICY_APPROVAL_REFUSED',
  CONTRACT_SIGNATURE_AUTHORITY_FLAGGED: 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
  CONTRACT_SIGNATURE_REFUSED: 'CONTRACT_SIGNATURE_REFUSED',
  CONTRACT_AMENDMENT_PROPOSED: 'CONTRACT_AMENDMENT_PROPOSED',
  CONTRACT_AMENDMENT_SIGNATURE_RECORDED: 'CONTRACT_AMENDMENT_SIGNATURE_RECORDED',
  CONTRACT_AMENDED: 'CONTRACT_AMENDED',
  CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED: 'CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED',
  CONTRACT_MILESTONE_PLANNED: 'CONTRACT_MILESTONE_PLANNED',
  CONTRACT_MILESTONE_CHANGED: 'CONTRACT_MILESTONE_CHANGED',
  CONTRACT_AUTHORITY_REFUSED: 'CONTRACT_AUTHORITY_REFUSED',
  STATEMENT_DRAFTED: 'STATEMENT_DRAFTED',
  STATEMENT_SUBMITTED: 'STATEMENT_SUBMITTED',
  STATEMENT_DECISION_RECORDED: 'STATEMENT_DECISION_RECORDED',
  STATEMENT_TECHNICALLY_APPROVED: 'STATEMENT_TECHNICALLY_APPROVED',
  STATEMENT_APPROVED: 'STATEMENT_APPROVED',
  STATEMENT_REJECTED: 'STATEMENT_REJECTED',
  STATEMENT_SETTLED: 'STATEMENT_SETTLED',
  CONTRACT_SETTLED: 'CONTRACT_SETTLED',
} as const;

export type ContractEventName = keyof typeof CONTRACT_EVENTS;

const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().check(isoDateTime({ offset: false }));

/**
 * A draft contract was made from an awarded tender (ADR-068 § 3). Keyed by
 * `contractId`; one per tender, so a redelivery of the award never publishes a second.
 */
export const contractDraftedPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    winningBidId: id,
    draftedAt: instant,
  })
  .strict();

/**
 * One side accepted the draft (CON-003 PR 2, Q-95 (1)): the audit fact of a signature, published
 * for **each** of the two, in the transaction that records it. The signer is named by user id —
 * an identifier, like `awardedBy` on `TENDER_AWARDED` — because a signature without a person is
 * no audit record; the identity pair used for the separation-of-duties check stays in this
 * service's database. **No amount.**
 */
export const contractSignatureRecordedPayload = z
  .object({
    contractId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    side: z.enum(['EMPLOYER', 'CONTRACTOR']),
    /** The organization the signer acted for. */
    signerOrganizationId: id,
    signedBy: id,
    /** The role the signature was accepted under: the policy's for the employer, CONTRACTOR for the contractor. */
    authorityRole: z.string().regex(/^[A-Z][A-Z_]*$/),
    /** The `contract.signature` policy that authorised the employer's side; null for the contractor's. */
    policyId: id.nullable(),
    policyVersion: z.number().int().min(1).nullable(),
    signedAt: instant,
  })
  .strict();

/**
 * Both sides have accepted the contract and it is SIGNED (ADR-068 § 2, CON-003 PR 2): the
 * `DRAFT → SIGNED` transition, which `docs/08` § 8.3 names `AWARDED → CONTRACTED`. Published
 * once, with the second signature, in the transaction that records it. **No amount, no
 * signer** — instants and organizations only; who signed is on each
 * `CONTRACT_SIGNATURE_RECORDED` and in the service's own signature record.
 */
export const contractSignedPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    winningBidId: id,
    employerSignedAt: instant,
    contractorSignedAt: instant,
    /** When the contract became SIGNED: the later of the two. */
    signedAt: instant,
  })
  .strict();

/**
 * The employer cancelled a draft (`DRAFT → CANCELLED`). The **closed reason code** only: the
 * optional free-text note stays in this service's database and is read through the API by
 * the two parties — it is client free text, and the topic is read by every service.
 */
export const contractCancelledPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    organizationId: id,
    contractorOrganizationId: id,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    cancelledAt: instant,
  })
  .strict();

const workflowKey = z.enum(WORKFLOW_KEYS);
const positive = z.number().int().min(1);

/** A signing policy was written (a DRAFT): who, for which organization, how many authorities. */
export const approvalPolicyCreatedPayload = z
  .object({
    policyId: id,
    /** The organization the policy governs. */
    organizationId: id,
    /** Who wrote it: the governed organization's union, or the platform. */
    authorOrganizationId: id,
    authorRole: z.enum(['UNION_ADMIN', 'SYSTEM_ADMIN']),
    workflowKey,
    policyVersion: positive,
    stepCount: positive,
    isSample: z.boolean(),
    createdBy: id,
    createdAt: instant,
  })
  .strict();

/** Sent for the platform administrator's approval (Q-70 (7)). */
export const approvalPolicySubmittedPayload = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey,
    policyVersion: positive,
    submittedBy: id,
    submittedAt: instant,
  })
  .strict();

/** Refused by the platform administrator. The reason stays with the policy. */
export const approvalPolicyRejectedPayload = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey,
    policyVersion: positive,
    rejectedBy: id,
    rejectedAt: instant,
  })
  .strict();

/** Put in force by the platform administrator's approval; `activatedBy` is that administrator. */
export const approvalPolicyActivatedPayload = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey,
    policyVersion: positive,
    /** The policy this one replaced, retired in the same transaction. */
    retiredPolicyId: id.nullable(),
    activatedBy: id,
    activatedAt: instant,
  })
  .strict();

export const approvalPolicyRetiredPayload = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey,
    policyVersion: positive,
    retiredBy: id,
    retiredAt: instant,
  })
  .strict();

/**
 * The platform approval of a policy was refused for separation of duties (four eyes, Q-70 (7)): the
 * approver is the person who wrote or submitted it. The audit record of the refusal, written in a
 * transaction of its own so it survives the request failing; the policy itself is unchanged. Who
 * asked, the closed reason — no free text.
 */
export const POLICY_APPROVAL_REFUSED_REASONS = [
  /** The approver wrote or submitted the policy. */
  'SELF_APPROVAL',
] as const;

export const approvalPolicyApprovalRefusedPayload = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey,
    policyVersion: positive,
    reason: z.enum(POLICY_APPROVAL_REFUSED_REASONS),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

/**
 * Taken out of force because the union that wrote it no longer governs the organization (Q-83),
 * the payload construction-service publishes for its own policies. `suspendedBy` is the system
 * actor; the cause is the ORGANIZATION_MOVED event and the organization it moved, or a signature
 * being attempted on it. No free text: the reason is a closed code.
 */
const approvalPolicySuspendedBase = {
  policyId: id,
  organizationId: id,
  authorOrganizationId: id,
  workflowKey,
  policyVersion: positive,
  /** In force, or still waiting for the platform approval, when it was suspended. */
  fromStatus: z.enum(['ACTIVE', 'PENDING_PLATFORM_APPROVAL']),
  suspendedBy: id,
  suspendedAt: instant,
};

/**
 * In exactly two shapes: a move proven to be the cause (`ORGANIZATION_MOVED`, which names the event
 * AND the organization it moved) or a finding that is not one (`MOVE_RECHECK`, a re-check a move
 * queued; `SIGNING_RECHECK`, a signature being attempted), which names NEITHER. One of the two
 * alone is not a published shape.
 */
export const approvalPolicySuspendedPayload = z.discriminatedUnion('reason', [
  z
    .object({
      ...approvalPolicySuspendedBase,
      reason: z.literal('ORGANIZATION_MOVED'),
      causeEventId: id,
      movedOrganizationId: id,
    })
    .strict(),
  z
    .object({
      ...approvalPolicySuspendedBase,
      reason: z.enum(['MOVE_RECHECK', 'SIGNING_RECHECK']),
      causeEventId: z.null(),
      movedOrganizationId: z.null(),
    })
    .strict(),
]);

/**
 * An employer signature may rest on authority that changed while it was being made (D-050): an
 * ORGANIZATION_MOVED that stranded the policy it was made under landed between the hierarchy
 * answer and the commit. Flagged for review, never revoked. Identifiers, a closed code and
 * instants only.
 */
const contractSignatureAuthorityFlaggedBase = {
  contractId: id,
  organizationId: id,
  side: z.literal('EMPLOYER'),
  policyId: id,
  policyVersion: positive,
  reason: z.literal('AUTHORITY_CHANGED_DURING_SIGNING'),
  /** The move's hierarchy version, which the signature's recorded one was lower than (D-050). */
  movedVersion: positive.nullable(),
  flaggedAt: instant,
};

/**
 * What found it, in exactly one of two shapes: a move proven to be the cause (`ORGANIZATION_MOVED`,
 * which names the event AND its instant) or a re-check a move queued without being shown to be its
 * cause (`MOVE_RECHECK`, which names NEITHER — never a wrong event). One of the two alone is not a
 * published shape — the same rule the `ck_review_detection` constraint holds in the database.
 */
export const contractSignatureAuthorityFlaggedPayload = z.discriminatedUnion('detectedBy', [
  z
    .object({
      ...contractSignatureAuthorityFlaggedBase,
      detectedBy: z.literal('ORGANIZATION_MOVED'),
      causeEventId: id,
      movedAt: instant,
    })
    .strict(),
  z
    .object({
      ...contractSignatureAuthorityFlaggedBase,
      detectedBy: z.literal('MOVE_RECHECK'),
      causeEventId: z.null(),
      movedAt: z.null(),
    })
    .strict(),
]);

/**
 * A signature was refused for want of authority (the audit record of the refusal, written in a
 * transaction of its own so it survives the request failing): no policy in force, or the union that
 * wrote it no longer governs the employer. Who asked, for which contract, and the closed reason —
 * no free text.
 */
export const contractSignatureRefusedPayload = z
  .object({
    contractId: id,
    organizationId: id,
    side: z.literal('EMPLOYER'),
    reason: z.enum(['SIGNATURE_POLICY_REQUIRED', 'POLICY_AUTHOR_NOT_GOVERNING']),
    /** The policy that was in force and stranded; null when none was. */
    policyId: id.nullable(),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

/**
 * An amendment of a signed contract was proposed by the employer (CON-003 PR 3). Identifiers, the
 * closed reason code and instants only: **no amount** (the topic is shared, as for
 * `CONTRACT_DRAFTED`) and **no reason text** (client free text, read through the API by the two
 * parties).
 */
export const contractAmendmentProposedPayload = z
  .object({
    contractId: id,
    amendmentId: id,
    amendmentNumber: z.number().int().min(1),
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    proposedBy: id,
    proposedAt: instant,
  })
  .strict();

/** One side signed an amendment: the audit fact, for each of the two. **No amount.** */
export const contractAmendmentSignatureRecordedPayload = z
  .object({
    contractId: id,
    amendmentId: id,
    organizationId: id,
    side: z.enum(['EMPLOYER', 'CONTRACTOR']),
    signerOrganizationId: id,
    signedBy: id,
    authorityRole: z.string().regex(/^[A-Z][A-Z_]*$/),
    /** The `contract.signature` policy that authorised the employer's side; null for the contractor's. */
    policyId: id.nullable(),
    policyVersion: z.number().int().min(1).nullable(),
    signedAt: instant,
  })
  .strict();

/**
 * Both parties signed the amendment and it is EFFECTIVE: the contract's price changed (the
 * catalogue's `CONTRACT_AMENDED`, without its `deltaAmount` — the amount is read through the API, as
 * for `CONTRACT_DRAFTED`). Published once, with the second signature, in the transaction that
 * records it and moves the contract's amendments total.
 */
export const contractAmendedPayload = z
  .object({
    contractId: id,
    amendmentId: id,
    amendmentNumber: z.number().int().min(1),
    organizationId: id,
    contractorOrganizationId: id,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    employerSignedAt: instant,
    contractorSignedAt: instant,
    /** When the amendment became effective: the later of the two signatures. */
    effectiveAt: instant,
  })
  .strict();

/** An employer amendment signature a move may have raced (D-050): flagged for review, never revoked. */
const amendmentSignatureAuthorityFlaggedBase = {
  contractId: id,
  amendmentId: id,
  organizationId: id,
  side: z.literal('EMPLOYER'),
  policyId: id,
  policyVersion: positive,
  reason: z.literal('AUTHORITY_CHANGED_DURING_SIGNING'),
  movedVersion: positive.nullable(),
  flaggedAt: instant,
};

/**
 * What found it, in exactly one of two shapes: a move proven to be the cause (`ORGANIZATION_MOVED`,
 * which names the event AND its instant) or a re-check a move queued without being shown to be its
 * cause (`MOVE_RECHECK`, which names NEITHER). One of the two alone is not a published shape — the
 * same rule the `ck_amendment_review_reason` constraint holds in the database.
 */
export const contractAmendmentSignatureAuthorityFlaggedPayload = z.discriminatedUnion(
  'detectedBy',
  [
    z
      .object({
        ...amendmentSignatureAuthorityFlaggedBase,
        detectedBy: z.literal('ORGANIZATION_MOVED'),
        causeEventId: id,
        movedAt: instant,
      })
      .strict(),
    z
      .object({
        ...amendmentSignatureAuthorityFlaggedBase,
        detectedBy: z.literal('MOVE_RECHECK'),
        causeEventId: z.null(),
        movedAt: z.null(),
      })
      .strict(),
  ],
);

/** A milestone was planned on a signed contract. Identifiers and instants only — no title, no date, no share. */
export const contractMilestonePlannedPayload = z
  .object({
    contractId: id,
    milestoneId: id,
    organizationId: id,
    contractorOrganizationId: id,
    plannedBy: id,
    plannedAt: instant,
  })
  .strict();

/** A milestone that no statement refers to was edited. `version` is the one it now has. */
export const contractMilestoneChangedPayload = z
  .object({
    contractId: id,
    milestoneId: id,
    organizationId: id,
    contractorOrganizationId: id,
    version: positive,
    changedBy: id,
    changedAt: instant,
  })
  .strict();

/**
 * A party's attempt at an authority-bound action on a contract was refused for want of authority
 * (the audit record of the refusal, written in a transaction of its own so it survives the request
 * failing): signing or cancelling the contract, proposing or signing an amendment, planning or
 * editing a milestone, drafting or submitting a statement, approving or rejecting a step of its
 * approval chains — refused for want of authority or for separation of duties. Who asked, for which
 * contract, the closed action and reason — no free text. Never written for a caller who is neither a
 * party nor an organization a submitted statement's chains name (`side` `APPROVER`, CON-003 PR 6):
 * such a caller is told the contract does not exist. A refusal of the contract's or statement's state
 * (a contract no longer a draft, a version moved on, a step not open) is not one of these: it is
 * answered and not audited. audit-service projects the same closed lists
 * (`contract-refusal-projection.ts`): a value added here is added there in the same change.
 */
export const AUTHORITY_REFUSED_ACTIONS = [
  'SIGN_CONTRACT',
  'CANCEL_CONTRACT',
  'PROPOSE_AMENDMENT',
  'SIGN_AMENDMENT',
  'PLAN_MILESTONE',
  'CHANGE_MILESTONE',
  /** The contractor drafts a statement of a signed contract (CON-003 PR 4). */
  'DRAFT_STATEMENT',
  /** The contractor submits a draft statement for approval (CON-003 PR 5). */
  'SUBMIT_STATEMENT',
  /** A step's authority approves or rejects a step of a submitted statement's chain (CON-003 PR 6). */
  'APPROVE_STATEMENT',
  'REJECT_STATEMENT',
] as const;
export const AUTHORITY_REFUSED_REASONS = [
  /** The caller's role is not one the configuration or the policy in force names. */
  'ROLE_NOT_PERMITTED',
  /** The action is the employer's and the caller acts for the contractor. */
  'NOT_EMPLOYER',
  /** The action is the contractor's and the caller acts for the employer (a statement). */
  'NOT_CONTRACTOR',
  'SIGNATURE_POLICY_REQUIRED',
  'POLICY_AUTHOR_NOT_GOVERNING',
  /** Separation of duties: the caller is a member of both parties to the contract. */
  'MEMBER_OF_BOTH_PARTIES',
  /** Separation of duties: the caller already signed the other side. */
  'SAME_PERSON_BOTH_SIDES',
  /** The platform administrator, acting for a party's organization, does not act for a party. */
  'PLATFORM_ADMINISTRATOR',
  /** A decision: the caller's organization is not the authority of the step it named (CON-003 PR 6). */
  'NOT_STEP_AUTHORITY',
  /** Separation of duties: the decider is also a member of the contractor's organization. */
  'MEMBER_OF_CONTRACTOR',
  /** Separation of duties: the decider submitted the statement (Q-96 (3)). */
  'SUBMITTER_MAY_NOT_DECIDE',
  /** Separation of duties: the decider already decided a step of the statement, in either chain. */
  'ALREADY_DECIDED_STATEMENT',
  /** Separation of duties cannot be shown: the decider and another cannot be told apart (#188). */
  'ACTOR_IDENTITY_UNKNOWN',
] as const;

/**
 * Which side the refused caller acted for: one of the two parties, or — for a decision only — an
 * organization a submitted statement's chain names that is neither (a supervising consultant, Q-96 (1)).
 */
export const AUTHORITY_REFUSED_SIDES = ['EMPLOYER', 'CONTRACTOR', 'APPROVER'] as const;

export const contractAuthorityRefusedPayload = z
  .object({
    contractId: id,
    organizationId: id,
    action: z.enum(AUTHORITY_REFUSED_ACTIONS),
    side: z.enum(AUTHORITY_REFUSED_SIDES),
    /**
     * The amendment, milestone or statement the action named; null when it created one (an
     * amendment, a milestone or a statement draft).
     */
    subjectId: id.nullable(),
    reason: z.enum(AUTHORITY_REFUSED_REASONS),
    /** The policy that was in force and stranded; null when none was or the reason is not a policy's. */
    policyId: id.nullable(),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

/**
 * The contractor drafted a statement of a signed contract (CON-003 PR 4, ADR-068 § 5).
 * Identifiers, its number and instants only: **no amount** — not the gross, not a deduction, not
 * the net (Q-97 (2): a consumer that needs one reads the API) — and no line text.
 */
export const statementDraftedPayload = z
  .object({
    contractId: id,
    statementId: id,
    statementNumber: positive,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    draftedBy: id,
    draftedAt: instant,
  })
  .strict();

/**
 * The contractor submitted a draft statement for approval (`DRAFT → SUBMITTED`, CON-003 PR 5,
 * ADR-068 § 5), in the transaction that snapshotted both approval chains. The catalogue's
 * `STATEMENT_SUBMITTED` without its `grossAmount` (Q-97 (2)): identifiers, versions and instants
 * only — the policy and version each chain was snapshotted from, and the milestones its lines refer
 * to (marked referenced by this submission if no earlier one did, Q-100 (4)). The steps themselves
 * and the amounts are read through the API. The submitter is named by user id; the identity pair
 * the approvals compare stays in this service's database.
 */
export const statementSubmittedPayload = z
  .object({
    contractId: id,
    statementId: id,
    statementNumber: positive,
    organizationId: id,
    contractorOrganizationId: id,
    technicalPolicyId: id,
    technicalPolicyVersion: positive,
    financialPolicyId: id,
    financialPolicyVersion: positive,
    milestoneIds: z.array(id).max(100),
    submittedBy: id,
    submittedAt: instant,
  })
  .strict();

const statementChain = z.enum(['TECHNICAL', 'FINANCIAL']);
const statementFacts = {
  contractId: id,
  statementId: id,
  statementNumber: positive,
  /** The employer — the tender's owner and the tenant of the contract. */
  organizationId: id,
  contractorOrganizationId: id,
};

/**
 * One step of a submitted statement's chain was decided (CON-003 PR 6, ADR-068 § 5): the audit fact
 * of each decision, like `CONTRACT_SIGNATURE_RECORDED` for a signature, in the transaction that
 * records it. The decider is named by user id and the organization and role the step's authority
 * is; the identity pair the separation of duties compares stays in this service's database. **No
 * amount.**
 */
export const statementDecisionRecordedPayload = z
  .object({
    ...statementFacts,
    chain: statementChain,
    stepOrder: positive,
    outcome: z.enum(['APPROVED', 'REJECTED']),
    deciderOrganizationId: id,
    deciderRole: z.string().regex(/^[A-Z][A-Z_]*$/),
    decidedBy: id,
    decidedAt: instant,
  })
  .strict();

/** The technical chain's last step was approved: SUBMITTED → TECHNICALLY_APPROVED, the financial chain opens. */
export const statementTechnicallyApprovedPayload = z
  .object({ ...statementFacts, technicallyApprovedAt: instant })
  .strict();

/**
 * The financial chain's last step was approved: TECHNICALLY_APPROVED → APPROVED, in the transaction
 * that moved the contract's approved total under its row lock (ADR-068 § 5, § 6 (1)). A **fact**,
 * not a payment order: identifiers and the instant only (Q-97 (2)) — the catalogue's `netAmount`,
 * `deductions` and approvers are not here; economic-service reads the statement through the API.
 */
export const statementApprovedPayload = z
  .object({ ...statementFacts, approvedAt: instant })
  .strict();

/**
 * A step of either chain was rejected: the statement is REJECTED, final for its number (Q-96 (7)).
 * Which step; no reason text (the catalogue's `reason` — none is collected).
 */
export const statementRejectedPayload = z
  .object({ ...statementFacts, chain: statementChain, stepOrder: positive, rejectedAt: instant })
  .strict();

/**
 * economic-service confirmed the statement's obligation settled in full: APPROVED → SETTLED
 * (CON-003 PR 6c, ADR-068 § 6 (3), I5), in the transaction that records the settlement. Which
 * obligation and which settlement of economic's, and when economic settled it — **no amount**
 * (Q-97 (2)): the statement's net is read from this service's API, the settlement from economic's.
 */
export const statementSettledPayload = z
  .object({ ...statementFacts, obligationId: id, settlementId: id, settledAt: instant })
  .strict();

/**
 * The contract is settled: COMPLETED → SETTLED (ADR-068 § 2 and § 6 (3)), in the transaction that
 * settled its last open statement — no statement open, and the sum settled the sum of the approved
 * net. `docs/08` § 8.3's `COMPLETED → SETTLED`. Identifiers and the instant only; **no amount**.
 */
export const contractSettledPayload = z
  .object({
    contractId: id,
    projectId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    settledAt: instant,
  })
  .strict();

export const CONTRACT_EVENT_SCHEMAS = {
  CONTRACT_DRAFTED: contractDraftedPayload,
  CONTRACT_SIGNATURE_RECORDED: contractSignatureRecordedPayload,
  CONTRACT_SIGNED: contractSignedPayload,
  CONTRACT_CANCELLED: contractCancelledPayload,
  APPROVAL_POLICY_CREATED: approvalPolicyCreatedPayload,
  APPROVAL_POLICY_SUBMITTED: approvalPolicySubmittedPayload,
  APPROVAL_POLICY_REJECTED: approvalPolicyRejectedPayload,
  APPROVAL_POLICY_ACTIVATED: approvalPolicyActivatedPayload,
  APPROVAL_POLICY_RETIRED: approvalPolicyRetiredPayload,
  APPROVAL_POLICY_SUSPENDED: approvalPolicySuspendedPayload,
  APPROVAL_POLICY_APPROVAL_REFUSED: approvalPolicyApprovalRefusedPayload,
  CONTRACT_SIGNATURE_AUTHORITY_FLAGGED: contractSignatureAuthorityFlaggedPayload,
  CONTRACT_SIGNATURE_REFUSED: contractSignatureRefusedPayload,
  CONTRACT_AMENDMENT_PROPOSED: contractAmendmentProposedPayload,
  CONTRACT_AMENDMENT_SIGNATURE_RECORDED: contractAmendmentSignatureRecordedPayload,
  CONTRACT_AMENDED: contractAmendedPayload,
  CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED: contractAmendmentSignatureAuthorityFlaggedPayload,
  CONTRACT_MILESTONE_PLANNED: contractMilestonePlannedPayload,
  CONTRACT_MILESTONE_CHANGED: contractMilestoneChangedPayload,
  CONTRACT_AUTHORITY_REFUSED: contractAuthorityRefusedPayload,
  STATEMENT_DRAFTED: statementDraftedPayload,
  STATEMENT_SUBMITTED: statementSubmittedPayload,
  STATEMENT_DECISION_RECORDED: statementDecisionRecordedPayload,
  STATEMENT_TECHNICALLY_APPROVED: statementTechnicallyApprovedPayload,
  STATEMENT_APPROVED: statementApprovedPayload,
  STATEMENT_REJECTED: statementRejectedPayload,
  STATEMENT_SETTLED: statementSettledPayload,
  CONTRACT_SETTLED: contractSettledPayload,
} as const satisfies Record<ContractEventName, z.ZodTypeAny>;

export type ContractEventPayload<N extends ContractEventName> = z.infer<
  (typeof CONTRACT_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload against its published contract **before** it reaches the
 * outbox, so a malformed event can never be committed. Throwing here rolls back the
 * caller's transaction: a state change nobody can be told about is not made.
 */
export function validateContractPayload<N extends ContractEventName>(
  eventName: N,
  payload: unknown,
): ContractEventPayload<N> {
  const schema = CONTRACT_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as ContractEventPayload<N>;
}
