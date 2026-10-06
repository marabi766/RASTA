import { z } from 'zod';
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
  CONTRACT_SIGNATURE_AUTHORITY_FLAGGED: 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
  CONTRACT_SIGNATURE_REFUSED: 'CONTRACT_SIGNATURE_REFUSED',
} as const;

export type ContractEventName = keyof typeof CONTRACT_EVENTS;

const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });

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
 * Taken out of force because the union that wrote it no longer governs the organization (Q-83),
 * the payload construction-service publishes for its own policies. `suspendedBy` is the system
 * actor; the cause is the ORGANIZATION_MOVED event and the organization it moved, or a signature
 * being attempted on it. No free text: the reason is a closed code.
 */
export const approvalPolicySuspendedPayload = z
  .object({
    policyId: id,
    organizationId: id,
    authorOrganizationId: id,
    workflowKey,
    policyVersion: positive,
    /** In force, or still waiting for the platform approval, when it was suspended. */
    fromStatus: z.enum(['ACTIVE', 'PENDING_PLATFORM_APPROVAL']),
    /** A move found it (the sweeper), or a signature being attempted on it did. */
    reason: z.enum(['ORGANIZATION_MOVED', 'SIGNING_RECHECK']),
    /** The ORGANIZATION_MOVED event and the organization it moved; null when a signature found it. */
    causeEventId: id.nullable(),
    movedOrganizationId: id.nullable(),
    suspendedBy: id,
    suspendedAt: instant,
  })
  .strict();

/**
 * An employer signature may rest on authority that changed while it was being made (D-050): an
 * ORGANIZATION_MOVED that stranded the policy it was made under landed between the hierarchy
 * answer and the commit. Flagged for review, never revoked. Identifiers, a closed code and
 * instants only.
 */
export const contractSignatureAuthorityFlaggedPayload = z
  .object({
    contractId: id,
    organizationId: id,
    side: z.literal('EMPLOYER'),
    policyId: id,
    policyVersion: positive,
    reason: z.literal('AUTHORITY_CHANGED_DURING_SIGNING'),
    /** The ORGANIZATION_MOVED event that stranded the policy, and when the move took effect. */
    causeEventId: id,
    movedAt: instant,
    /** The move's hierarchy version, which the signature's recorded one was lower than (D-050). */
    movedVersion: positive.nullable(),
    flaggedAt: instant,
  })
  .strict();

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
  CONTRACT_SIGNATURE_AUTHORITY_FLAGGED: contractSignatureAuthorityFlaggedPayload,
  CONTRACT_SIGNATURE_REFUSED: contractSignatureRefusedPayload,
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
