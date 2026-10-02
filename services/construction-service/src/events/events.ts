import { z } from 'zod';
import { PROJECT_STATES } from '../project/project.state-machine';
import { WORKFLOW_KEYS } from '../approval/approval.state-machine';
import { CANCELLATION_CODES, TENDER_STATES } from '../tender/tender.state-machine';

/**
 * Events published by construction-service, on `rasta.construction.v1`.
 *
 * `PROJECT_CREATED` comes from the platform catalogue (`docs/04` § 4.12,
 * `docs/events/README.md` § Construction). The other six were added for CON-001
 * and approved by the project manager: every change to a project or a need is a
 * state change audit-service must hear about (AGENTS.md S-06, A-08), and the
 * catalogue had no event for editing, cancelling or the need lifecycle.
 *
 * The payloads are defined here because this service owns them (ADR-032); the
 * only cross-service contract in `packages/contracts` is the audit trail.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, states, timestamps, amounts and bounded codes only — no free
 * text, no personal data, no document identifier and no geometry.** An event
 * lives seven days in a log every service can read (`docs/07` § 7.3). A title,
 * an operation type (free text unless a deployment lists the allowed values,
 * Q-68), a scope of work, a need's description and a stated cancellation or
 * withdrawal reason are prose somebody wrote for their own organization, not
 * for every consumer on the platform; they stay in this service's database. The
 * operating area can hold hundreds of vertices, so `PROJECT_CREATED` says only
 * `hasArea`. A consumer that needs any of it asks the API, under its
 * authorization (Codex review of #119, finding 4).
 *
 * The `*_UPDATED` events carry the **names** of the fields that changed, never
 * their values — the rule `ASSET_UPDATED` and `DRIVER_UPDATED` already follow.
 *
 * ## What these payloads never claim
 *
 * `PROJECT_STATUS_CHANGED` to `APPROVED` is published only in the transaction
 * of the last required grant, and only a named authority's decision produces
 * one: no policy, no applicable step, a timeout or silence never approves
 * anything (ADR-023, Q-70, Q-73).
 */

export const CONSTRUCTION_EVENTS = {
  PROJECT_CREATED: 'PROJECT_CREATED',
  PROJECT_UPDATED: 'PROJECT_UPDATED',
  PROJECT_STATUS_CHANGED: 'PROJECT_STATUS_CHANGED',
  PROJECT_NEED_ADDED: 'PROJECT_NEED_ADDED',
  PROJECT_NEED_UPDATED: 'PROJECT_NEED_UPDATED',
  PROJECT_NEED_SUBMITTED: 'PROJECT_NEED_SUBMITTED',
  PROJECT_NEED_WITHDRAWN: 'PROJECT_NEED_WITHDRAWN',
  // CON-001 PR 2 — catalogue events.
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  PROJECT_STARTED: 'PROJECT_STARTED',
  PROJECT_PROGRESS_UPDATED: 'PROJECT_PROGRESS_UPDATED',
  PROJECT_COMPLETED: 'PROJECT_COMPLETED',
  // CON-001 PR 2 — added so policy and progress-draft changes reach audit;
  // approved by the project manager (2026-09-26).
  APPROVAL_POLICY_CREATED: 'APPROVAL_POLICY_CREATED',
  APPROVAL_POLICY_ACTIVATED: 'APPROVAL_POLICY_ACTIVATED',
  APPROVAL_POLICY_RETIRED: 'APPROVAL_POLICY_RETIRED',
  // Q-83: taken out of force by the system when an ORGANIZATION_MOVED means
  // the union that wrote it no longer governs the organization.
  APPROVAL_POLICY_SUSPENDED: 'APPROVAL_POLICY_SUSPENDED',
  // Q-70 (7), decided 2026-09-26: the platform approval step (names approved
  // by the PM, 2026-09-26).
  APPROVAL_POLICY_SUBMITTED: 'APPROVAL_POLICY_SUBMITTED',
  APPROVAL_POLICY_REJECTED: 'APPROVAL_POLICY_REJECTED',
  PROJECT_PROGRESS_REPORT_DRAFTED: 'PROJECT_PROGRESS_REPORT_DRAFTED',
  PROJECT_PROGRESS_REPORT_DISCARDED: 'PROJECT_PROGRESS_REPORT_DISCARDED',
  // CON-002 (ADR-065). `TENDER_CREATED` is a catalogue event; `TENDER_CANCELLED`
  // was accepted by the project manager (2026-09-30); `TENDER_UPDATED` follows
  // the `PROJECT_UPDATED` precedent (a DRAFT edit is a state change audit must
  // hear about, S-06) and is flagged for acceptance in the PR.
  TENDER_CREATED: 'TENDER_CREATED',
  TENDER_UPDATED: 'TENDER_UPDATED',
  TENDER_CANCELLED: 'TENDER_CANCELLED',
  // CON-002 PR 4a. Both added for S-06 (a criteria change is a state change
  // audit must hear about); flagged for the project manager's acceptance.
  CRITERIA_TEMPLATE_CREATED: 'CRITERIA_TEMPLATE_CREATED',
  TENDER_CRITERIA_SET: 'TENDER_CRITERIA_SET',
  // CON-002 PR 4b. `TENDER_PUBLISHED` is a catalogue event; `TENDER_BIDDER_INVITED`
  // is added for S-06 (an invitation decides who may bid) and awaits acceptance.
  TENDER_PUBLISHED: 'TENDER_PUBLISHED',
  TENDER_BIDDER_INVITED: 'TENDER_BIDDER_INVITED',
  // CON-002 PR 6 (ADR-066). `BID_SUBMITTED` is a catalogue event; `BID_REVISED`,
  // `BID_WITHDRAWN` and `BID_ACCESSED` were accepted by the project manager
  // (2026-09-30). Identifiers, digests and times only: never content, a price or a note.
  BID_SUBMITTED: 'BID_SUBMITTED',
  BID_REVISED: 'BID_REVISED',
  BID_WITHDRAWN: 'BID_WITHDRAWN',
  BID_ACCESSED: 'BID_ACCESSED',
  // CON-002 PR 7 (ADR-065 § 3). Accepted by the project manager (2026-09-30).
  TENDER_CLOSED: 'TENDER_CLOSED',
  // CON-002 PR 8 (ADR-066). Accepted by the project manager (2026-09-30). Ids and counts only.
  BIDS_OPENED: 'BIDS_OPENED',
  // CON-002 PR 8, Codex #184 R4. `BID_OPENING_CONFLICT_DETECTED` is named by the project
  // manager (2026-10-02); `BID_OPENING_PROPOSAL_WITHDRAWN` is added for S-06 (a proposal
  // taken back, or cleared, is a state change audit must hear about) and awaits acceptance.
  BID_OPENING_PROPOSAL_WITHDRAWN: 'BID_OPENING_PROPOSAL_WITHDRAWN',
  BID_OPENING_CONFLICT_DETECTED: 'BID_OPENING_CONFLICT_DETECTED',
} as const;

export type ConstructionEventName = (typeof CONSTRUCTION_EVENTS)[keyof typeof CONSTRUCTION_EVENTS];

const identifier = z.string().min(1).max(64);
const isoTimestamp = z.string().datetime();
const amountMinor = z.string().regex(/^\d{1,19}$/);
const projectState = z.enum(PROJECT_STATES);

/** Field names only; sorted and unique so the payload is stable for one change. */
const changedFields = z
  .array(z.string().min(1).max(64))
  .min(1)
  .refine((fields) => new Set(fields).size === fields.length, 'changedFields must be unique');

export const projectCreatedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    /** Rial minor units as a string, or null while no estimate was given. */
    estimatedCostMinor: amountMinor.nullable(),
    /** Whether an operating area was recorded. The polygon itself is not carried. */
    hasArea: z.boolean(),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

export const projectUpdatedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    changedFields,
    updatedBy: identifier,
    updatedAt: isoTimestamp,
  })
  .strict();

/**
 * A project changed status by a transition that has no dedicated event.
 *
 * In PR 1 that is only cancellation. The stated reason is not carried: it is
 * prose, kept in `project.status_reason` and read through the API.
 */
export const projectStatusChangedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    from: projectState,
    to: projectState,
    changedBy: identifier,
    changedAt: isoTimestamp,
  })
  .strict()
  .refine((value) => value.from !== value.to, 'A status change must change the status');

export const projectNeedAddedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    addedBy: identifier,
    addedAt: isoTimestamp,
  })
  .strict();

export const projectNeedUpdatedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    changedFields,
    updatedBy: identifier,
    updatedAt: isoTimestamp,
  })
  .strict();

export const projectNeedSubmittedPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    submittedBy: identifier,
    submittedAt: isoTimestamp,
  })
  .strict();

export const projectNeedWithdrawnPayload = z
  .object({
    projectId: identifier,
    needId: identifier,
    organizationId: identifier,
    withdrawnBy: identifier,
    withdrawnAt: isoTimestamp,
  })
  .strict();

// ---------------------------------------------------------------------------
// CON-001 PR 2
// ---------------------------------------------------------------------------

const workflowKey = z.enum(WORKFLOW_KEYS);
const positive = z.number().int().positive();

/** The step identity every approval event carries. */
const approvalStep = {
  approvalId: identifier,
  projectId: identifier,
  organizationId: identifier,
  workflowKey,
  round: positive,
  stepOrder: positive,
};

/**
 * One step of a round was put to its authority. The authority is named as the
 * policy named it — an (organization, role) — which is what notification-service
 * needs to reach it (`docs/07`: notification (مرجع تأیید)). The step's
 * `approvalType` and `authorityLabel` are text a policy writer typed; they stay
 * in the database with the step, like every other prose field.
 */
export const approvalRequestedPayload = z
  .object({
    ...approvalStep,
    authorityOrganizationId: identifier,
    authorityRole: z.string().min(1).max(64),
    policyId: identifier,
    policyVersion: positive,
    requestedAt: isoTimestamp,
  })
  .strict();

/**
 * The authority granted the step. The catalogue's `conditions` is prose, so the
 * event says only whether conditions were recorded; they, and the decision
 * number, are read through the API.
 */
export const approvalGrantedPayload = z
  .object({
    ...approvalStep,
    decidedBy: identifier,
    decidedAt: isoTimestamp,
    hasConditions: z.boolean(),
  })
  .strict();

/** The authority rejected the step. The stated reason stays in the database. */
export const approvalRejectedPayload = z
  .object({
    ...approvalStep,
    decidedBy: identifier,
    decidedAt: isoTimestamp,
  })
  .strict();

/**
 * Execution began. `contractId` is the catalogue field and is always `null`
 * until the contract boundary exists (CON-003, Q-71): null says "no contract
 * is claimed", not "this producer does not know".
 */
export const projectStartedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    contractId: z.null(),
    startedBy: identifier,
    startedAt: isoTimestamp,
  })
  .strict();

/**
 * A progress report was submitted. The catalogue's `percentage` is carried as
 * `progressBasisPoints` (0..10000), an integer, never a float (AGENTS.md § 3).
 *
 * `assetsUsed` is deliberately **not** here (Codex review of #122): the
 * identifiers are stored with the report, but their ownership is not yet
 * verified against asset-service, so they are not published — a consumer
 * must never read an unverified claim that project P used asset A. `.strict()`
 * refuses the field.
 */
export const projectProgressUpdatedPayload = z
  .object({
    projectId: identifier,
    reportId: identifier,
    organizationId: identifier,
    progressBasisPoints: z.number().int().min(0).max(10_000),
    submittedBy: identifier,
    submittedAt: isoTimestamp,
  })
  .strict();

export const projectCompletedPayload = z
  .object({
    projectId: identifier,
    organizationId: identifier,
    completedBy: identifier,
    completedAt: isoTimestamp,
  })
  .strict();

export const approvalPolicyCreatedPayload = z
  .object({
    policyId: identifier,
    /** The organization the policy governs. */
    organizationId: identifier,
    /** Who wrote it: the governed organization's union, or the platform. */
    authorOrganizationId: identifier,
    authorRole: z.enum(['UNION_ADMIN', 'SYSTEM_ADMIN']),
    workflowKey,
    policyVersion: positive,
    stepCount: positive,
    isSample: z.boolean(),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

/** Sent for the platform administrator's approval (Q-70 (7)). */
export const approvalPolicySubmittedPayload = z
  .object({
    policyId: identifier,
    organizationId: identifier,
    workflowKey,
    policyVersion: positive,
    submittedBy: identifier,
    submittedAt: isoTimestamp,
  })
  .strict();

/** Refused by the platform administrator. The reason stays with the policy. */
export const approvalPolicyRejectedPayload = z
  .object({
    policyId: identifier,
    organizationId: identifier,
    workflowKey,
    policyVersion: positive,
    rejectedBy: identifier,
    rejectedAt: isoTimestamp,
  })
  .strict();

/**
 * Put in force by the platform administrator's approval (Q-70 (7));
 * `activatedBy` is that administrator.
 */
export const approvalPolicyActivatedPayload = z
  .object({
    policyId: identifier,
    organizationId: identifier,
    workflowKey,
    policyVersion: positive,
    /** The policy this one replaced, retired in the same transaction. */
    retiredPolicyId: identifier.nullable(),
    activatedBy: identifier,
    activatedAt: isoTimestamp,
  })
  .strict();

/**
 * Taken out of force because the union that wrote it no longer governs the
 * organization (Q-83). `suspendedBy` is the system actor; the cause is the
 * ORGANIZATION_MOVED event and the organization it moved, or a round being
 * opened. No free text: the reason is a closed code.
 */
export const approvalPolicySuspendedPayload = z
  .object({
    policyId: identifier,
    organizationId: identifier,
    authorOrganizationId: identifier,
    workflowKey,
    policyVersion: positive,
    /** In force, or still waiting for the platform approval, when it was suspended. */
    fromStatus: z.enum(['ACTIVE', 'PENDING_PLATFORM_APPROVAL']),
    /** A move found it (the sweeper), or a round being opened on it did. */
    reason: z.enum(['ORGANIZATION_MOVED', 'ROUND_OPENING_RECHECK']),
    /** The ORGANIZATION_MOVED event and the organization it moved; null when a round found it. */
    causeEventId: identifier.nullable(),
    movedOrganizationId: identifier.nullable(),
    suspendedBy: identifier,
    suspendedAt: isoTimestamp,
  })
  .strict();

export const approvalPolicyRetiredPayload = z
  .object({
    policyId: identifier,
    organizationId: identifier,
    workflowKey,
    policyVersion: positive,
    retiredBy: identifier,
    retiredAt: isoTimestamp,
  })
  .strict();

export const progressReportDraftedPayload = z
  .object({
    projectId: identifier,
    reportId: identifier,
    organizationId: identifier,
    draftedBy: identifier,
    draftedAt: isoTimestamp,
  })
  .strict();

export const progressReportDiscardedPayload = z
  .object({
    projectId: identifier,
    reportId: identifier,
    organizationId: identifier,
    discardedBy: identifier,
    discardedAt: isoTimestamp,
  })
  .strict();

// ---------------------------------------------------------------------------
// CON-002 — tenders (ADR-065). Keyed by `tenderId`, about a `Tender`.
//
// **No payload carries a title, the scope of work, a stated reason, a bid, a
// price or any free text.** They stay in this service's database; a consumer
// asks the API under its own authorization.
// ---------------------------------------------------------------------------

const tenderState = z.enum(TENDER_STATES);
const procurementNature = z.enum(['FORMAL_TENDER', 'INQUIRY', 'RFP', 'MARKETPLACE_DEAL']);

const tenderIdentity = {
  tenderId: identifier,
  projectId: identifier,
  organizationId: identifier,
};

export const tenderCreatedPayload = z
  .object({
    ...tenderIdentity,
    /** Null until the owner chooses it; the platform never defaults it (Q-03). */
    procurementNature: procurementNature.nullable(),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

export const tenderUpdatedPayload = z
  .object({
    ...tenderIdentity,
    changedFields,
    updatedBy: identifier,
    updatedAt: isoTimestamp,
  })
  .strict();

/** The stated reason is prose and stays in the database; the code is a closed set. */
export const tenderCancelledPayload = z
  .object({
    ...tenderIdentity,
    from: tenderState,
    reasonCode: z.enum(CANCELLATION_CODES),
    cancelledBy: identifier,
    cancelledAt: isoTimestamp,
  })
  .strict();

/**
 * A criteria template was written (a new version of a label). The label and the
 * criteria are text an organization typed and stay in the database; the event
 * says that one exists, its version and how many criteria it has.
 */
export const criteriaTemplateCreatedPayload = z
  .object({
    templateId: identifier,
    organizationId: identifier,
    version: z.number().int().positive(),
    criteriaCount: z.number().int().positive(),
    totalWeightBp: z.number().int().positive().max(10_000),
    createdBy: identifier,
    createdAt: isoTimestamp,
  })
  .strict();

/** A DRAFT tender's criteria were replaced. Counts and weights only, never codes or labels. */
export const tenderCriteriaSetPayload = z
  .object({
    ...tenderIdentity,
    criteriaCount: z.number().int().positive(),
    totalWeightBp: z.number().int().positive().max(10_000),
    /** The template they were copied from, or null when written out. */
    templateId: identifier.nullable(),
    setBy: identifier,
    setAt: isoTimestamp,
  })
  .strict();

/**
 * A tender was opened to bidders. Carries the window and how many criteria are
 * frozen — never a title, the scope, a criterion or the tender's public key.
 * `keyId` is an opaque identifier of the key pair bids will be sealed to.
 */
export const tenderPublishedPayload = z
  .object({
    ...tenderIdentity,
    visibility: z.enum(['PUBLIC', 'RESTRICTED']),
    bidOpeningAt: isoTimestamp,
    bidClosingAt: isoTimestamp,
    criteriaCount: z.number().int().positive(),
    keyId: identifier,
    publishedBy: identifier,
    publishedAt: isoTimestamp,
  })
  .strict();

/**
 * A tender stopped taking bids: its deadline passed and the sweeper (or a person)
 * closed it. `bidCount` is the bids standing at that moment (withdrawn ones are
 * not counted); nothing about them is carried. `closedBy` is the system actor for
 * the sweeper.
 */
export const tenderClosedPayload = z
  .object({
    ...tenderIdentity,
    bidCount: z.number().int().nonnegative(),
    closedAt: isoTimestamp,
    closedBy: identifier,
  })
  .strict();

/** An organization was invited to a RESTRICTED tender. */
export const tenderBidderInvitedPayload = z
  .object({
    ...tenderIdentity,
    invitedOrganizationId: identifier,
    invitedBy: identifier,
    invitedAt: isoTimestamp,
  })
  .strict();

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const bidIdentity = {
  bidId: identifier,
  tenderId: identifier,
  /** The tender's owner. */
  organizationId: identifier,
  bidderOrganizationId: identifier,
};

/**
 * A bid was submitted (or replaced: `BID_REVISED`, the same shape with a higher
 * `revision`). Carries the receipt the bidder is given and the chain it extends:
 * `receipt` is the new **head** of the tender's chain, which audit-service keeps
 * outside this service's database so that opening can be checked against it
 * (ADR-066 § 2-3). Digests are safe to publish; the content, the price and the
 * ciphertext never are.
 */
const bidSealedPayload = z
  .object({
    ...bidIdentity,
    revision: z.number().int().positive(),
    receivedAt: isoTimestamp,
    contentCommitment: sha256Hex,
    ciphertextSha256: sha256Hex,
    previousReceipt: sha256Hex,
    receipt: sha256Hex,
    submittedBy: identifier,
  })
  .strict();

export const bidSubmittedPayload = bidSealedPayload;
export const bidRevisedPayload = bidSealedPayload;

export const bidWithdrawnPayload = z
  .object({
    ...bidIdentity,
    revision: z.number().int().positive(),
    withdrawnAt: isoTimestamp,
    withdrawnBy: identifier,
  })
  .strict();

/**
 * Closed codes for why a bid was read (ADR-066 § 5): the bidder's own receipt; the owner
 * opening the bids, or proposing to (four eyes, Q-91; no bid is read); the owner counting the bids before the opening (no identity, no
 * content); the owner reading them afterwards, listed or one by one.
 */
export const BID_ACCESS_PURPOSES = [
  'OWN_BID_RECEIPT',
  'OPEN_BIDS',
  'PROPOSE_OPENING',
  'WITHDRAW_PROPOSAL',
  'COUNT_BIDS',
  'LIST_BIDS',
  'READ_BID',
] as const;
export type BidAccessPurpose = (typeof BID_ACCESS_PURPOSES)[number];

/** A read of a bid, granted or refused (ADR-066 § 5): who, which bid, why, the outcome — no content. */
export const bidAccessedPayload = z
  .object({
    /** Null when the read named no bid that exists for the reader. */
    bidId: identifier.nullable(),
    tenderId: identifier,
    organizationId: identifier,
    accessorOrganizationId: identifier,
    accessedBy: identifier,
    purpose: z.enum(BID_ACCESS_PURPOSES),
    outcome: z.enum(['GRANTED', 'REFUSED']),
    accessedAt: isoTimestamp,
  })
  .strict();

/**
 * The bids of a tender were opened (CLOSED → EVALUATING). A count, a digest of the bids'
 * identifiers and the head of the receipt chain they were verified against — never a
 * price, an answer, a note, a ciphertext or a key. Bounded by design: the event does not
 * grow with the number of bids (a list of them could exceed any cap, and a tender with
 * more bids than the cap could then never be opened); the identifiers themselves are read
 * through the owner's API (`GET /v1/tenders/:id/bids`). `bidIdsDigest` is SHA-256, in
 * hex, of the opened bids' identifiers sorted ascending and joined with `\n`, so a
 * consumer holding the list can check it against the event. `receiptHead` is a digest
 * and already public (it is the head audit-service holds). `proposedBy` is the first of
 * the two people when four-eyes applies (Q-91), null when it is switched off.
 */
export const bidsOpenedPayload = z
  .object({
    ...tenderIdentity,
    bidCount: z.number().int().nonnegative(),
    bidIdsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    receiptHead: z.string().regex(/^[0-9a-f]{64}$/),
    openedAt: isoTimestamp,
    openedBy: identifier,
    proposedBy: identifier.nullable(),
  })
  .strict();

/**
 * The proposal to open a tender's bids (four-eyes, Q-91) was taken back by its proposer, or
 * cleared by the approval that found the proposer a member of a bidding organization — so
 * another eligible user can propose afresh. Ids only.
 */
export const bidOpeningProposalWithdrawnPayload = z
  .object({
    tenderId: identifier,
    organizationId: identifier,
    proposedBy: identifier,
    /** Who took it back (the proposer) or whose approval found the proposer conflicted. */
    withdrawnBy: identifier,
    reason: z.enum(['WITHDRAWN_BY_PROPOSER', 'PROPOSER_CONFLICTED']),
    withdrawnAt: isoTimestamp,
  })
  .strict();

/**
 * After an opening committed, identity-service said that the proposer or the approver was a
 * member of a bidding organization at that very instant — the race the conflict check at the
 * approval cannot close (ADR-066 § 4, residual). The detective control: ids only, who and
 * which of the bidding organizations (at most 100 each; `organizationCount` is the whole).
 */
export const bidOpeningConflictDetectedPayload = z
  .object({
    tenderId: identifier,
    organizationId: identifier,
    openedAt: isoTimestamp,
    openedBy: identifier,
    proposedBy: identifier.nullable(),
    /** The instant identity-service was asked about: the opening's commit. */
    checkedAt: isoTimestamp,
    conflicts: z
      .array(
        z
          .object({
            userId: identifier,
            role: z.enum(['PROPOSER', 'APPROVER']),
            organizationIds: z.array(identifier).min(1).max(100),
            organizationCount: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();

export const CONSTRUCTION_EVENT_SCHEMAS = {
  PROJECT_CREATED: projectCreatedPayload,
  PROJECT_UPDATED: projectUpdatedPayload,
  PROJECT_STATUS_CHANGED: projectStatusChangedPayload,
  PROJECT_NEED_ADDED: projectNeedAddedPayload,
  PROJECT_NEED_UPDATED: projectNeedUpdatedPayload,
  PROJECT_NEED_SUBMITTED: projectNeedSubmittedPayload,
  PROJECT_NEED_WITHDRAWN: projectNeedWithdrawnPayload,
  APPROVAL_REQUESTED: approvalRequestedPayload,
  APPROVAL_GRANTED: approvalGrantedPayload,
  APPROVAL_REJECTED: approvalRejectedPayload,
  PROJECT_STARTED: projectStartedPayload,
  PROJECT_PROGRESS_UPDATED: projectProgressUpdatedPayload,
  PROJECT_COMPLETED: projectCompletedPayload,
  APPROVAL_POLICY_CREATED: approvalPolicyCreatedPayload,
  APPROVAL_POLICY_ACTIVATED: approvalPolicyActivatedPayload,
  APPROVAL_POLICY_RETIRED: approvalPolicyRetiredPayload,
  APPROVAL_POLICY_SUSPENDED: approvalPolicySuspendedPayload,
  APPROVAL_POLICY_SUBMITTED: approvalPolicySubmittedPayload,
  APPROVAL_POLICY_REJECTED: approvalPolicyRejectedPayload,
  PROJECT_PROGRESS_REPORT_DRAFTED: progressReportDraftedPayload,
  PROJECT_PROGRESS_REPORT_DISCARDED: progressReportDiscardedPayload,
  TENDER_CREATED: tenderCreatedPayload,
  TENDER_UPDATED: tenderUpdatedPayload,
  TENDER_CANCELLED: tenderCancelledPayload,
  CRITERIA_TEMPLATE_CREATED: criteriaTemplateCreatedPayload,
  TENDER_CRITERIA_SET: tenderCriteriaSetPayload,
  TENDER_PUBLISHED: tenderPublishedPayload,
  TENDER_BIDDER_INVITED: tenderBidderInvitedPayload,
  BID_SUBMITTED: bidSubmittedPayload,
  BID_REVISED: bidRevisedPayload,
  BID_WITHDRAWN: bidWithdrawnPayload,
  BID_ACCESSED: bidAccessedPayload,
  TENDER_CLOSED: tenderClosedPayload,
  BIDS_OPENED: bidsOpenedPayload,
  BID_OPENING_PROPOSAL_WITHDRAWN: bidOpeningProposalWithdrawnPayload,
  BID_OPENING_CONFLICT_DETECTED: bidOpeningConflictDetectedPayload,
} as const satisfies Record<ConstructionEventName, z.ZodTypeAny>;

export type ConstructionEventPayload<N extends ConstructionEventName> = z.infer<
  (typeof CONSTRUCTION_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload at publish time, not only in a test (`docs/07` § 7.8).
 *
 * Thrown inside the caller's transaction, so an invalid payload rolls back the
 * state change too rather than committing a fact nobody will hear about.
 */
export function validateConstructionPayload<N extends ConstructionEventName>(
  eventName: N,
  payload: unknown,
): ConstructionEventPayload<N> {
  const schema = CONSTRUCTION_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as ConstructionEventPayload<N>;
}
