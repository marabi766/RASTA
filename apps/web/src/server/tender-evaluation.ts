import { z } from 'zod';

import type { ScoringCell } from '@/lib/tender-owner-input';

import type { ReadResult } from './assets';
import type { WebServerEnv } from './env';
import { utcInstant } from './instant';
import { canReadProjects } from './portal-nav';
import type { WebSession } from './session';
import {
  AWARD_SCHEMA,
  AWARD_WORKFLOW,
  BID_EXCLUDED_ROLES,
  canOpenBids,
  decidableStep,
  mayGrant,
  readOwnerView,
  tenderPath,
  type ApprovalRequest,
  type OwnerBids,
  type OwnerCaller,
  type OwnerOffer,
  type TenderAward,
} from './tender-owner';

/**
 * A tender's evaluation and award, read and commanded through the gateway
 * (EXP-004; construction-service CON-002 PRs 9–11, ADR-067, Q-84, Q-88..Q-93).
 * The commands themselves are built and sent by `server/tender-owner.ts`, with
 * the owner's others: one slot, one stamp, one action.
 *
 * ## What is read
 *
 * - `GET /v1/tenders/{id}/evaluation` — the matrix: every opened bid with its
 *   decision, each evaluator's latest cells and totals, who stood down, the
 *   ranking (a tie shares a rank and makes no winner), and whether the
 *   evaluation may be completed (`ready`, exactly what `evaluate` would
 *   answer). Only for a caller the service would admit as an evaluator: it
 *   audits every read, per bid, and refuses a member of a bidding organization
 *   (`CONFLICT_OF_INTEREST`) and — with `EVALUATOR_NOT_TENDER_AUTHOR` — the
 *   tender's author. A matrix that answered is therefore the proof that this
 *   person passes every check an evaluation command makes before its own.
 * - `GET /v1/tenders/{id}/approvals?workflowKey=tender.award` — the award's
 *   requests, by status and steps only.
 * - `GET /v1/approvals/{id}` — an award step names the bid, its rank and the
 *   justification, and is read under the rules of deciding it (none of the
 *   bid side's excluded roles, no bidder membership, and — with
 *   `AWARDER_NOT_EVALUATOR` — none of the evaluators): its refusal is the
 *   service's own answer to "may this person decide it".
 * - `GET /v1/tenders/{id}/award` — the award, with the winner's price, once it
 *   is made; only for a caller the service would admit as an awarder.
 *
 * ## Who may command — a copy of construction-service, never a rule of our own
 *
 * `canEvaluate` and `canAward` are `assertCanEvaluate` and `assertCanAward`;
 * the matrix says the rest of what an evaluator's command checks before its
 * own rules (`evaluationOffers`). An award's eligibility is `awardOffers`. What
 * the views cannot show is left to the service and said in fixed words: one
 * person under two user ids (`SAME_PERSON_AS_EVALUATOR`, `AWARDER_IS_EVALUATOR`
 * compared on stable identity), identity-service's word as of now, and
 * supplier-service's on a contractor's standing.
 */

const digits = z.string().regex(/^\d+$/, 'a non-negative integer, as a decimal string');

const cellSchema = z.object({
  criterionCode: z.string(),
  scoreScaled: z.number().int().min(0),
  revision: z.number().int().min(1),
  scoredAt: utcInstant,
});

const matrixBidSchema = z.object({
  bidId: z.string(),
  bidderOrganizationId: z.string(),
  bidStatus: z.string(),
  qualification: z
    .object({
      decision: z.enum(['QUALIFIED', 'DISQUALIFIED']),
      reasonCode: z.string().nullable(),
      reasonText: z.string().nullable(),
      decidedBy: z.string(),
      decidedAt: utcInstant,
    })
    .nullable(),
  evaluations: z.array(
    z.object({
      evaluatorId: z.string(),
      complete: z.boolean(),
      totalScaled: digits.nullable(),
      cells: z.array(cellSchema),
    }),
  ),
  recusals: z.array(
    z.object({ evaluatorId: z.string(), reasonCode: z.string(), recusedAt: utcInstant }),
  ),
  evaluatorCount: z.number().int().min(0),
  totalScaled: digits.nullable(),
  rank: z.number().int().min(1).nullable(),
  tied: z.boolean(),
});

export type MatrixBid = z.infer<typeof matrixBidSchema>;

/** `matrixViewSchema`, less the matrix digest no screen reads. */
export const MATRIX_SCHEMA = z.object({
  tenderId: z.string(),
  status: z.string(),
  frozen: z.boolean(),
  criteria: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      weightBp: z.number().int(),
      scoringMethod: z.string(),
      maxScore: z.number().int().min(0),
    }),
  ),
  maxTotalScaled: digits,
  minEvaluators: z.number().int().min(1),
  maxEvaluators: z.number().int().min(1),
  ready: z.boolean(),
  readinessBlockedBy: z.string().nullable(),
  undecidedBidCount: z.number().int().min(0),
  blockers: z.array(
    z.object({
      bidId: z.string(),
      completeEvaluators: z.number().int(),
      required: z.number().int(),
    }),
  ),
  bids: z.array(matrixBidSchema),
});

export type EvaluationMatrix = z.infer<typeof MATRIX_SCHEMA>;

/** `approvalViewSchema` of an award step: what a decision is made against, and the bid it names. */
export const AWARD_APPROVAL_SCHEMA = z.object({
  id: z.string(),
  tenderId: z.string().nullable(),
  workflowKey: z.string(),
  status: z.string(),
  authorityOrganizationId: z.string(),
  authorityRole: z.string(),
  version: z.number().int().min(1),
  request: z
    .object({
      requestId: z.string(),
      tenderVersion: z.number().int(),
      status: z.string(),
      requestedBy: z.string(),
      bid: z
        .object({
          bidId: z.string(),
          bidderOrganizationId: z.string(),
          rank: z.number().int(),
          tied: z.boolean(),
          justification: z.string().nullable(),
          standingVerdict: z.string(),
          standingAsOf: utcInstant,
        })
        .nullable(),
    })
    .nullable(),
});

export type AwardApproval = z.infer<typeof AWARD_APPROVAL_SCHEMA>;

// -- reads -------------------------------------------------------------------------------

/** The matrix of one of the caller's own tenders; another's, or a missing one, is `NOT_FOUND`. */
export async function fetchEvaluation(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<EvaluationMatrix>> {
  const matrix = await readOwnerView(session, `${tenderPath(tenderId)}/evaluation`, MATRIX_SCHEMA);
  if (matrix.kind === 'OK' && matrix.data.tenderId !== tenderId) {
    return { kind: 'MALFORMED', correlationId: '' };
  }
  return matrix;
}

/** One award step, with the bid its request names. */
export async function fetchAwardApproval(
  session: WebSession,
  approvalId: string,
): Promise<ReadResult<AwardApproval>> {
  const step = await readOwnerView(
    session,
    `/v1/approvals/${encodeURIComponent(approvalId)}`,
    AWARD_APPROVAL_SCHEMA,
  );
  if (
    step.kind === 'OK' &&
    (step.data.id !== approvalId || step.data.workflowKey !== AWARD_WORKFLOW)
  ) {
    return { kind: 'MALFORMED', correlationId: '' };
  }
  return step;
}

/** The award, once made: a tender not yet awarded is `NOT_FOUND`, as the service answers. */
export async function fetchAward(
  session: WebSession,
  tenderId: string,
): Promise<ReadResult<TenderAward>> {
  const award = await readOwnerView(session, `${tenderPath(tenderId)}/award`, AWARD_SCHEMA);
  if (award.kind === 'OK' && award.data.tenderId !== tenderId) {
    return { kind: 'MALFORMED', correlationId: '' };
  }
  return award;
}

// -- who may command ---------------------------------------------------------------------

export type EvaluationSettings = Pick<
  WebServerEnv,
  | 'WEB_PROJECT_ROLES'
  | 'WEB_PROJECT_READER_ROLES'
  | 'WEB_TENDER_OPEN_ROLES'
  | 'WEB_TENDER_EVALUATE_ROLES'
  | 'WEB_TENDER_AWARD_ROLES'
  | 'WEB_TENDER_COI_RULES'
>;

/**
 * `assertOwnerBidSide(roles)`: none of `BID_EXCLUDED_ROLES` whenever present,
 * one of the configured roles (else the project roles, less the excluded
 * ones), an organization acted for; and the routes' `@RequirePlatformUserId`.
 */
function ownerBidSide(
  caller: OwnerCaller,
  configured: readonly string[],
  projectRoles: readonly string[],
): boolean {
  const { roles } = caller;
  if (roles === null || caller.organizationId === null || !caller.platformUser) return false;
  if (BID_EXCLUDED_ROLES.some((role) => roles.includes(role))) return false;
  const allowed = (configured.length > 0 ? configured : projectRoles).filter(
    (role) => !BID_EXCLUDED_ROLES.includes(role),
  );
  return allowed.some((role) => roles.includes(role));
}

/** `assertCanEvaluate` (`CONSTRUCTION_TENDER_EVALUATE_ROLES`), and a platform user id. */
export function canEvaluate(caller: OwnerCaller, settings: EvaluationSettings): boolean {
  return ownerBidSide(caller, settings.WEB_TENDER_EVALUATE_ROLES, settings.WEB_PROJECT_ROLES);
}

/** `assertCanAward` (`CONSTRUCTION_TENDER_AWARD_ROLES`), and a platform user id. */
export function canAward(caller: OwnerCaller, settings: EvaluationSettings): boolean {
  return ownerBidSide(caller, settings.WEB_TENDER_AWARD_ROLES, settings.WEB_PROJECT_ROLES);
}

/**
 * `assertMayDecideAward`: the approver of an award holds none of the roles the
 * bid side excludes, whenever present. The policy names who approves; this is
 * on top of it.
 */
export function mayDecideAward(caller: OwnerCaller): boolean {
  const { roles } = caller;
  return roles !== null && !BID_EXCLUDED_ROLES.some((role) => roles.includes(role));
}

/**
 * A caller of the bid side who may not read the tender itself (PR 345 review 1,
 * finding 4, widened to the evaluation): the tender read is `assertCanRead`,
 * while the opening, `GET …/bids`, the matrix and the evaluators' commands are
 * `assertCanOpenBids` or `assertCanEvaluate` alone. Such a caller's page reads
 * only what those roles may.
 */
export function isBidSideOnly(caller: OwnerCaller, settings: EvaluationSettings): boolean {
  return (
    caller.roles !== null &&
    !canReadProjects(caller.roles, settings) &&
    (canOpenBids(caller, settings) || canEvaluate(caller, settings))
  );
}

/**
 * Everyone the matrix names as having taken part in the evaluation, by user
 * id: who decided on a bid, scored one (an evaluation exists from the first
 * score), or stood down from one — `AwardRepository.listParticipants`. Who
 * completed it the matrix does not name; the tender does (`statusChangedBy`
 * of an `EVALUATED` tender, which completing sets — `statusChangedByCaller`).
 * The service compares people on their stable identity; a user id it names is
 * the same person by any measure.
 */
export function evaluationParticipants(matrix: EvaluationMatrix): ReadonlySet<string> {
  const people = new Set<string>();
  for (const bid of matrix.bids) {
    if (bid.qualification) people.add(bid.qualification.decidedBy);
    for (const evaluation of bid.evaluations) people.add(evaluation.evaluatorId);
    for (const recusal of bid.recusals) people.add(recusal.evaluatorId);
  }
  return people;
}

export type EvaluationNote =
  /** No qualified bid and none undecided: the tender can only be cancelled. */
  | 'NO_QUALIFIED_BID'
  /** A bid undecided, or a qualified one short of complete evaluators. */
  | 'EVALUATION_INCOMPLETE'
  /** `readinessBlockedBy`: the counted evaluators are not provably distinct people. */
  | 'READINESS_BLOCKED';

/**
 * The evaluators' offers on an `EVALUATING` tender, the checks in the
 * services' order once the matrix answered (which already passed the roles,
 * identity now, the conflicts of interest and the author rule):
 *
 * - **decide** an `OPENED` bid nobody has decided on — qualify or disqualify —
 *   unless this person stood down from it (`RECUSED`);
 * - **score** a `QUALIFIED` bid this person did not stand down from, if they
 *   already evaluate it or it has room for one more evaluator
 *   (`countActiveEvaluators` < `maxEvaluators`, those who stood down not
 *   counted), each criterion bound to the revision of their own cell the page
 *   read;
 * - **complete** when the matrix is `ready` — what `evaluate` would answer.
 */
export function evaluationOffers(
  caller: OwnerCaller,
  matrix: ReadResult<EvaluationMatrix> | null,
  settings: EvaluationSettings,
): { readonly offers: readonly OwnerOffer[]; readonly notes: readonly EvaluationNote[] } {
  const offers: OwnerOffer[] = [];
  const notes: EvaluationNote[] = [];
  const actor = caller.actorId;
  if (matrix?.kind !== 'OK' || matrix.data.status !== 'EVALUATING') return { offers, notes };
  if (actor === null || !canEvaluate(caller, settings)) return { offers, notes };
  const view = matrix.data;

  for (const bid of view.bids) {
    const stoodDown = new Set(bid.recusals.map((recusal) => recusal.evaluatorId));
    if (stoodDown.has(actor)) continue;
    if (bid.bidStatus === 'OPENED' && bid.qualification === null) {
      offers.push({ command: 'QUALIFY', bidId: bid.bidId });
      offers.push({ command: 'DISQUALIFY', bidId: bid.bidId });
      continue;
    }
    if (bid.bidStatus !== 'QUALIFIED') continue;
    const own = bid.evaluations.find((evaluation) => evaluation.evaluatorId === actor);
    const active = bid.evaluations.filter(
      (evaluation) => !stoodDown.has(evaluation.evaluatorId),
    ).length;
    if (!own && active >= view.maxEvaluators) continue;
    const scoring: ScoringCell[] = view.criteria.map((criterion) => ({
      criterionCode: criterion.code,
      maxScore: criterion.maxScore,
      passFail: criterion.scoringMethod === 'PASS_FAIL',
      expectedRevision:
        own?.cells.find((cell) => cell.criterionCode === criterion.code)?.revision ?? 0,
    }));
    if (scoring.length > 0) offers.push({ command: 'SCORE', bidId: bid.bidId, scoring });
  }

  if (view.ready) {
    offers.push({ command: 'EVALUATE' });
  } else if (view.readinessBlockedBy !== null) {
    notes.push('READINESS_BLOCKED');
  } else if (
    view.undecidedBidCount === 0 &&
    !view.bids.some((bid) => bid.qualification?.decision === 'QUALIFIED')
  ) {
    notes.push('NO_QUALIFIED_BID');
  } else {
    notes.push('EVALUATION_INCOMPLETE');
  }
  return { offers, notes };
}

export type AwardNote =
  /** A request is being decided, and not by this person. */
  | 'AWARD_PENDING'
  /** This person made the pending request. */
  | 'OWN_AWARD_REQUEST'
  /** Approved on this version: only executing it is offered. */
  | 'AWARD_APPROVED'
  /** This person took part in the evaluation (`AWARDER_NOT_EVALUATOR`): the award is someone else's. */
  | 'AWARDER_IS_EVALUATOR'
  /** The award's requests could not be read: what to offer is unknown. */
  | 'AWARD_REQUESTS_UNREAD'
  /**
   * The matrix is not readable to this person (the evaluators' roles, or the author rule): the
   * page knows neither the ranks nor whether they took part — the service judges both.
   */
  | 'AWARD_MATRIX_UNREAD'
  /** Neither the matrix nor the opener's view of the bids is readable: no qualified bid to name. */
  | 'AWARD_BIDS_UNREAD'
  /** The step this person decides, or the approved request to execute, could not be read. */
  | 'AWARD_STEP_UNREAD'
  /** The service refused this person the step: it would refuse the decision for the same reason. */
  | 'AWARD_STEP_REFUSED';

export interface AwardState {
  readonly tender: { readonly status: string; readonly version: number };
  /** Whether this person completed the evaluation (`statusChangedBy` of the `EVALUATED` tender). */
  readonly completedByCaller: boolean;
  readonly matrix: ReadResult<EvaluationMatrix> | null;
  /** The opener's view of the bids: which are qualified, when the matrix cannot say. */
  readonly bids?: ReadResult<OwnerBids> | null;
  readonly request: ReadResult<ApprovalRequest | null> | null;
  /** The award step read for this person: the one they decide, or one of the approved request. */
  readonly step: ReadResult<AwardApproval> | null;
}

/**
 * Which award step the page reads for this person, or null: the `PENDING`
 * step they are the authority of (`decidableStep`, and `assertMayDecideAward`);
 * or — an awarder, with the newest request approved on the tender's version
 * now — a step of that request, for the bid and justification to execute.
 */
export function awardStepToRead(
  caller: OwnerCaller,
  tender: AwardState['tender'],
  request: ApprovalRequest | null,
  settings: EvaluationSettings,
): string | null {
  if (tender.status !== 'EVALUATED' || request === null) return null;
  const decidable = mayDecideAward(caller) ? decidableStep(caller, request, tender.version) : null;
  if (decidable) return decidable.approvalId;
  if (
    request.status === 'APPROVED' &&
    request.tenderVersion === tender.version &&
    canAward(caller, settings)
  ) {
    return request.steps.at(-1)?.approvalId ?? null;
  }
  return null;
}

/**
 * The award's offers on an `EVALUATED` tender:
 *
 * - **decide** the pending step this person is the authority of, read for its
 *   version — reject always, grant only if they did not make the request;
 * - **award**, for an awarder (`assertCanAward`) who — with
 *   `AWARDER_NOT_EVALUATOR`, as far as the page can see — took no part in the
 *   evaluation. Decided from what the award path needs (PR 346 review 1,
 *   finding 2), not from the evaluators' read: with the newest request approved
 *   on this version, only executing it, with the bid and justification its step
 *   names — no matrix needed; otherwise one form per `QUALIFIED` bid, from the
 *   matrix when this person may read it (ranked: a justification required for
 *   anything but the single first rank, `JUSTIFICATION_REQUIRED`), else from the
 *   opener's view of the bids (unranked: the justification is the person's to
 *   give, and the service says in fixed words when the rank needed one). A
 *   pending request does not hold it back: another choice ends it and asks anew
 *   (`TenderApprovalGate.resolve`). Who took part the matrix names; without it
 *   the service judges (`AWARDER_IS_EVALUATOR`, in fixed words).
 */
export function awardOffers(
  caller: OwnerCaller,
  state: AwardState,
  settings: EvaluationSettings,
): { readonly offers: readonly OwnerOffer[]; readonly notes: readonly AwardNote[] } {
  const offers: OwnerOffer[] = [];
  const notes: AwardNote[] = [];
  const { tender, matrix, request, step } = state;
  if (tender.status !== 'EVALUATED') return { offers, notes };
  const latest = request?.kind === 'OK' ? request.data : null;
  const stepId = awardStepToRead(caller, tender, latest, settings);
  const decides = latest !== null && latest.status === 'PENDING' && stepId !== null;

  if (decides) {
    if (step?.kind === 'OK' && step.data.id === stepId) {
      const commands = mayGrant(caller, latest)
        ? (['GRANT_AWARD', 'REJECT_AWARD'] as const)
        : (['REJECT_AWARD'] as const);
      for (const command of commands) {
        offers.push({ command, approvalId: stepId, expectedVersion: step.data.version });
      }
    } else {
      notes.push(step?.kind === 'FORBIDDEN' ? 'AWARD_STEP_REFUSED' : 'AWARD_STEP_UNREAD');
    }
  }

  if (!canAward(caller, settings) || caller.actorId === null) return { offers, notes };
  if (request === null || request.kind !== 'OK') {
    notes.push('AWARD_REQUESTS_UNREAD');
    return { offers, notes };
  }
  const ranked = matrix?.kind === 'OK' ? matrix.data : null;
  if (
    settings.WEB_TENDER_COI_RULES.includes('AWARDER_NOT_EVALUATOR') &&
    (state.completedByCaller ||
      (ranked !== null && evaluationParticipants(ranked).has(caller.actorId)))
  ) {
    notes.push('AWARDER_IS_EVALUATOR');
    return { offers, notes };
  }
  if (ranked === null) notes.push('AWARD_MATRIX_UNREAD');

  if (latest?.status === 'APPROVED' && latest.tenderVersion === tender.version) {
    notes.push('AWARD_APPROVED');
    const bid = step?.kind === 'OK' && step.data.id === stepId ? step.data.request?.bid : null;
    if (bid) {
      offers.push({
        command: 'AWARD',
        bidId: bid.bidId,
        award: { justificationRequired: false, execution: { justification: bid.justification } },
      });
    } else {
      notes.push(step?.kind === 'FORBIDDEN' ? 'AWARD_STEP_REFUSED' : 'AWARD_STEP_UNREAD');
    }
    return { offers, notes };
  }

  if (latest?.status === 'PENDING' && latest.tenderVersion === tender.version) {
    notes.push(latest.requestedBy === caller.actorId ? 'OWN_AWARD_REQUEST' : 'AWARD_PENDING');
  }
  if (ranked !== null) {
    for (const bid of ranked.bids) {
      if (bid.bidStatus !== 'QUALIFIED' || bid.rank === null) continue;
      offers.push({
        command: 'AWARD',
        bidId: bid.bidId,
        award: { justificationRequired: bid.rank !== 1 || bid.tied, execution: null },
      });
    }
    return { offers, notes };
  }
  const listed = state.bids?.kind === 'OK' && state.bids.data.opened ? state.bids.data : null;
  if (listed === null) {
    notes.push('AWARD_BIDS_UNREAD');
    return { offers, notes };
  }
  for (const bid of listed.bids) {
    if (bid.status !== 'QUALIFIED') continue;
    offers.push({
      command: 'AWARD',
      bidId: bid.bidId,
      award: { justificationRequired: null, execution: null },
    });
  }
  return { offers, notes };
}

/** Whether the matrix is asked for: an evaluator, on a tender whose bids are opened. */
export function readsEvaluation(
  caller: OwnerCaller,
  status: string,
  settings: EvaluationSettings,
): boolean {
  return ['EVALUATING', 'EVALUATED', 'AWARDED'].includes(status) && canEvaluate(caller, settings);
}
