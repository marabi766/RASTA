import { compareActors, type ActorIdentity } from '@rasta/nest-common';
import type { StatementChain } from '../policy/policy.state-machine';
import {
  statementTransitionFor,
  type StatementCommandName,
  type StatementStateName,
} from './statement.state-machine';

/**
 * What a decision on a statement's approval chain may be, and what it does (ADR-068 § 5, Q-96 (2),
 * (3) and (7); CON-003 PR 6) — the one place that decides it, pure, so the command and its tests
 * read the same rule. The database checks the same (`statement_decision_guard`,
 * `statement_decisions_consistent`).
 *
 * - **Technical, then financial.** The technical chain is open while the statement is SUBMITTED,
 *   the financial chain once it is TECHNICALLY_APPROVED; each chain's steps are decided in their
 *   order, each at most once. A DRAFT is not yet decided on, an APPROVED or REJECTED one never again.
 * - **What a decision does.** A rejection rejects the statement — final for that number (Q-96 (7)).
 *   An approval of a chain's last undecided step completes the chain: TECHNICALLY_APPROVED, then
 *   APPROVED. Any other approval is recorded and moves nothing but the version.
 * - **Separation of duties** (Q-96 (3)): the decider is provably not the submitter and provably
 *   none of the people who decided this statement before, in either chain — compared on the stable
 *   identity (`compareActors`, #188). A pair that cannot be told apart refuses (fail closed).
 */

export type DecisionOutcome = 'APPROVED' | 'REJECTED';

export interface SnapshotStep {
  readonly chain: StatementChain;
  readonly stepOrder: number;
  readonly authorityOrganizationId: string;
  readonly authorityRole: string;
}

export interface RecordedDecision {
  readonly chain: StatementChain;
  readonly stepOrder: number;
  readonly outcome: DecisionOutcome;
}

/** Why a step cannot be decided now, whoever asks: the statement's state, not the caller's authority. */
export type StepRefusal =
  | 'STATEMENT_NOT_SUBMITTED'
  | 'STATEMENT_DECIDED'
  | 'STEP_NOT_IN_CHAIN'
  | 'STEP_DECIDED'
  | 'CHAIN_NOT_OPEN'
  | 'STEP_NOT_NEXT';

export type StepJudgement =
  | {
      readonly ok: true;
      readonly step: SnapshotStep;
      /** The status after the decision: the same one when it completes nothing. */
      readonly to: StatementStateName;
      /** The transition it makes, or null when it completes nothing. */
      readonly command: StatementCommandName | null;
    }
  | { readonly ok: false; readonly reason: StepRefusal };

/** The chain decisions are taken on in `status`, or null when none is open. */
export function openChain(status: StatementStateName): StatementChain | null {
  if (status === 'SUBMITTED') return 'TECHNICAL';
  if (status === 'TECHNICALLY_APPROVED') return 'FINANCIAL';
  return null;
}

const decidedOne = (
  decisions: readonly RecordedDecision[],
  step: { readonly chain: StatementChain; readonly stepOrder: number },
) =>
  decisions.some(
    (decision) => decision.chain === step.chain && decision.stepOrder === step.stepOrder,
  );

/** The undecided steps of `chain`, in their order. */
function undecided(
  steps: readonly SnapshotStep[],
  decisions: readonly RecordedDecision[],
  chain: StatementChain,
): SnapshotStep[] {
  return steps
    .filter((step) => step.chain === chain && !decidedOne(decisions, step))
    .sort((a, b) => a.stepOrder - b.stepOrder);
}

/**
 * Whether the step named (`chain`, `stepOrder`) of a statement in `status`, snapshotted as `steps`
 * and decided so far as `decisions`, can be decided `outcome` now — and what that does.
 */
export function judgeStep(
  status: StatementStateName,
  steps: readonly SnapshotStep[],
  decisions: readonly RecordedDecision[],
  named: { readonly chain: StatementChain; readonly stepOrder: number },
  outcome: DecisionOutcome,
): StepJudgement {
  if (status === 'DRAFT') return { ok: false, reason: 'STATEMENT_NOT_SUBMITTED' };
  const open = openChain(status);
  if (!open) return { ok: false, reason: 'STATEMENT_DECIDED' };
  const step = steps.find(
    (candidate) => candidate.chain === named.chain && candidate.stepOrder === named.stepOrder,
  );
  if (!step) return { ok: false, reason: 'STEP_NOT_IN_CHAIN' };
  if (decidedOne(decisions, step)) return { ok: false, reason: 'STEP_DECIDED' };
  if (step.chain !== open) return { ok: false, reason: 'CHAIN_NOT_OPEN' };
  const remaining = undecided(steps, decisions, open);
  if (remaining[0]?.stepOrder !== step.stepOrder) return { ok: false, reason: 'STEP_NOT_NEXT' };

  const command: StatementCommandName | null =
    outcome === 'REJECTED'
      ? 'reject'
      : remaining.length > 1
        ? null
        : open === 'TECHNICAL'
          ? 'approve_technical'
          : 'approve_financial';
  if (command === null) return { ok: true, step, to: status, command };
  const transition = statementTransitionFor(status, command);
  if (!transition) throw new Error(`no ${command} from ${status}`);
  return { ok: true, step, to: transition.to, command };
}

/**
 * The status a submitted statement's decisions give it — the rule `statement_decisions_consistent`
 * holds at commit: any rejection, REJECTED; every financial step approved, APPROVED; every technical
 * step approved, TECHNICALLY_APPROVED; else SUBMITTED.
 */
export function statusOfDecisions(
  counts: Readonly<Record<StatementChain, number>>,
  decisions: readonly RecordedDecision[],
): StatementStateName {
  if (decisions.some((decision) => decision.outcome === 'REJECTED')) return 'REJECTED';
  const approved = (chain: StatementChain) =>
    decisions.filter((decision) => decision.chain === chain && decision.outcome === 'APPROVED')
      .length;
  if (approved('FINANCIAL') === counts.FINANCIAL) return 'APPROVED';
  if (approved('TECHNICAL') === counts.TECHNICAL) return 'TECHNICALLY_APPROVED';
  return 'SUBMITTED';
}

/** Which separation-of-duties rule a decider breaks, if any; `UNKNOWN` when it cannot be shown. */
export type Separation = 'DISTINCT' | 'SUBMITTER' | 'ALREADY_DECIDED' | 'UNKNOWN';

/**
 * Whether `decider` is provably neither the submitter nor anyone who already decided this statement,
 * in either chain. A proven match is named first (it is the more precise refusal); any pair that
 * cannot be told apart is `UNKNOWN`.
 */
export function separationOf(
  decider: ActorIdentity,
  submitter: ActorIdentity,
  earlierDeciders: readonly ActorIdentity[],
): Separation {
  const toSubmitter = compareActors(decider, submitter);
  if (toSubmitter === 'SAME') return 'SUBMITTER';
  const toDeciders = earlierDeciders.map((earlier) => compareActors(decider, earlier));
  if (toDeciders.includes('SAME')) return 'ALREADY_DECIDED';
  if (toSubmitter === 'UNKNOWN' || toDeciders.includes('UNKNOWN')) return 'UNKNOWN';
  return 'DISTINCT';
}
