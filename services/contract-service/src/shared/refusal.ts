import { ERROR_CODES, type ErrorCode, type ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';

/**
 * Where a refusal's closed reason travels: the platform's error `details` (docs/06 § 6.7), one
 * entry per reason — `{ path: <area>, code: <reason>, message }` — as identity-service,
 * asset-service and construction-service (#227) send theirs. A client branches on the top-level
 * `code` first and on `details[].code` for why; it never parses `message`.
 *
 * `path` names the area whose rule refused (it is not a field of the request body).
 */
export const REFUSAL_AREAS = {
  signature: 'Contract cannot be signed',
  cancellation: 'Contract cannot be cancelled',
  policy: 'Approval policy cannot be written',
  amendment: 'Amendment cannot be made',
  milestone: 'Milestone cannot be planned',
  statement: 'Statement cannot be drafted or submitted',
  decision: 'Statement cannot be decided',
} as const;
export type RefusalArea = keyof typeof REFUSAL_AREAS;

/**
 * The closed reasons of each area, and the status each is answered with: a person who may not
 * act is 403, a state that moved under the command is 409, a rule is 422. One table, read by the
 * service (a reason that is not here does not compile) and by the OpenAPI document (each route's
 * 403, 409 and 422 type their `details` from it), so the two cannot disagree.
 */
export const REFUSAL_REASONS = {
  signature: {
    SIGNATURE_POLICY_REQUIRED: 422,
    /** The union that wrote the employer's signing policy no longer governs the employer (Q-83). */
    POLICY_AUTHOR_NOT_GOVERNING: 403,
    CONTRACT_NOT_DRAFT: 422,
    ACTOR_IDENTITY_UNKNOWN: 422,
    MEMBER_OF_BOTH_PARTIES: 403,
    SAME_PERSON_BOTH_SIDES: 403,
    SIDE_ALREADY_SIGNED: 409,
  },
  cancellation: {
    CANCEL_REASON_NOT_ALLOWED: 422,
    CONTRACT_NOT_DRAFT: 422,
    SIGNATURE_RECORDED: 422,
  },
  policy: {
    AUTHORITY_NOT_GOVERNED_ORGANIZATION: 422,
    /** Amount bounds on a step of a workflow that is not a statement chain (CON-003 PR 5). */
    AMOUNT_BOUNDS_NOT_APPLICABLE: 422,
  },
  /** Proposing and signing an amendment (CON-003 PR 3, Q-100); the signing reasons are the contract's own. */
  amendment: {
    /** Only the employer proposes. */
    PROPOSER_NOT_EMPLOYER: 403,
    SIGNATURE_POLICY_REQUIRED: 422,
    POLICY_AUTHOR_NOT_GOVERNING: 403,
    MEMBER_OF_BOTH_PARTIES: 403,
    SAME_PERSON_BOTH_SIDES: 403,
    SIDE_ALREADY_SIGNED: 409,
    ACTOR_IDENTITY_UNKNOWN: 422,
    CONTRACT_NOT_SIGNED: 422,
    AMENDMENT_NOT_PROPOSED: 422,
    /** Zero or negative: no document allows a reduction (Q-100). */
    AMENDMENT_DELTA_NOT_POSITIVE: 422,
    /** The price plus the amendments would pass the largest amount a bigint stores. */
    AMENDMENT_EXCEEDS_LIMIT: 422,
    AMENDMENT_REASON_NOT_ALLOWED: 422,
  },
  /** Planning and editing a milestone. */
  milestone: {
    EDITOR_NOT_EMPLOYER: 403,
    CONTRACT_NOT_SIGNED: 422,
    MILESTONE_REFERENCED: 422,
    MILESTONE_LIMIT_REACHED: 422,
  },
  /** Drafting (CON-003 PR 4) and submitting (PR 5) a statement (ADR-068 § 5, Q-96). */
  statement: {
    /** The contractor drafts and submits; the employer's approvers decide (Q-96). */
    AUTHOR_NOT_CONTRACTOR: 403,
    CONTRACT_NOT_SIGNED: 422,
    /** A deduction that is not a rule the employer configured and keeps in force (Q-96 (6)). */
    DEDUCTION_NOT_CONFIGURED: 422,
    /** The deductions would take more than the gross (ADR-068 § 5: net ≥ 0). */
    STATEMENT_NET_NEGATIVE: 422,
    /** The lines sum past the largest amount a bigint stores. */
    STATEMENT_EXCEEDS_LIMIT: 422,
    /** A line's milestone is not a planned milestone of this contract (Q-100 (4)). */
    MILESTONE_NOT_OF_CONTRACT: 422,
    /** Only a draft is submitted. */
    STATEMENT_NOT_DRAFT: 422,
    /** The submitter's stable identity is unknown, so no approval could keep them out (#188). */
    ACTOR_IDENTITY_UNKNOWN: 422,
    /** No `contract.statement.technical` policy is in force for the employer: no submission (Q-96 (1)). */
    TECHNICAL_POLICY_REQUIRED: 422,
    /** No `contract.statement.financial` policy is in force for the employer. */
    FINANCIAL_POLICY_REQUIRED: 422,
    /** The technical policy in force has no step that applies to this statement's gross. */
    TECHNICAL_STEP_NOT_APPLICABLE: 422,
    /** The financial policy in force has no step that applies to this statement's gross. */
    FINANCIAL_STEP_NOT_APPLICABLE: 422,
    /** A step that applies names the contractor's own organization: it never approves its own claim. */
    APPROVAL_STEP_NAMES_CONTRACTOR: 422,
    /** The union that wrote a chain's policy in force no longer governs the employer (Q-70 (7)). */
    POLICY_AUTHOR_NOT_GOVERNING: 422,
  },
  /** Deciding a step of a submitted statement's approval chain (CON-003 PR 6, ADR-068 § 5, Q-96). */
  decision: {
    /** The caller's organization is not the authority the named step's snapshot names. */
    NOT_STEP_AUTHORITY: 403,
    /** Separation of duties: the decider is also a member of the contractor's organization. */
    MEMBER_OF_CONTRACTOR: 403,
    /** Separation of duties: the decider is the person who submitted the statement (Q-96 (3)). */
    SUBMITTER_MAY_NOT_DECIDE: 422,
    /** Separation of duties: the decider already decided a step of this statement, in either chain. */
    ALREADY_DECIDED_STATEMENT: 422,
    /** The decider and the submitter, or an earlier decider, cannot be told apart (#188). */
    ACTOR_IDENTITY_UNKNOWN: 422,
    CONTRACT_NOT_SIGNED: 422,
    /** A draft: nothing to decide yet. */
    STATEMENT_NOT_SUBMITTED: 422,
    /** APPROVED or REJECTED: final (Q-96 (7)). */
    STATEMENT_DECIDED: 422,
    /** The named step is not one of the statement's snapshot. */
    STEP_NOT_IN_CHAIN: 422,
    /** The financial chain opens only after the technical one is done (Q-96 (2)). */
    CHAIN_NOT_OPEN: 422,
    /** An earlier step of the chain is still undecided: the steps are decided in their order. */
    STEP_NOT_NEXT: 422,
    /** The named step has been decided (by another person, or at the same moment). */
    STEP_DECIDED: 409,
    /** Approving it would take the approved gross past the price and the amendments (Q-96 (5)). */
    APPROVED_TOTAL_EXCEEDS_CAP: 422,
  },
} as const satisfies Record<RefusalArea, Record<string, 403 | 409 | 422>>;

export type ReasonOf<A extends RefusalArea> = Extract<keyof (typeof REFUSAL_REASONS)[A], string>;

/**
 * The `details` of a refusal: one entry per closed reason, each with a fixed message that names
 * the area and the code and nothing else (no id, no value, no input). Only a reason of the area's
 * own closed list reaches `details` (S-09); no closed reason, no `details`.
 */
export function refusalDetails(
  area: RefusalArea,
  reasons: readonly string[],
): ErrorDetail[] | undefined {
  const closed = reasons.filter((reason) =>
    Object.prototype.hasOwnProperty.call(REFUSAL_REASONS[area], reason),
  );
  if (closed.length === 0) return undefined;
  return closed.map((code) => ({ path: area, code, message: `${REFUSAL_AREAS[area]}: ${code}` }));
}

/**
 * A refusal with its closed reasons. `message` is for people; `context` is for the server's log
 * only (`RastaError.internalContext`, S-09).
 */
export function refusal<A extends RefusalArea>(
  code: ErrorCode,
  message: string,
  area: A,
  reasons: readonly ReasonOf<A>[],
  context: Record<string, unknown> = {},
): RastaError {
  return new RastaError(code, message, {
    details: refusalDetails(area, reasons),
    internalContext: { ...context, refusals: [...reasons] },
  });
}

/** 422 `BUSINESS_RULE_VIOLATION` with its closed reasons. */
export function ruleRefusal<A extends RefusalArea>(
  message: string,
  area: A,
  reasons: readonly ReasonOf<A>[],
  context: Record<string, unknown> = {},
): RastaError {
  return refusal(ERROR_CODES.BUSINESS_RULE_VIOLATION, message, area, reasons, context);
}

/** 403 `FORBIDDEN` with its closed reasons: the person may not act, however the state stands. */
export function forbiddenRefusal<A extends RefusalArea>(
  message: string,
  area: A,
  reasons: readonly ReasonOf<A>[],
  context: Record<string, unknown> = {},
): RastaError {
  return refusal(ERROR_CODES.FORBIDDEN, message, area, reasons, context);
}
