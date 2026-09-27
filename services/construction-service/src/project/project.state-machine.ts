import { RastaError } from '@rasta/nest-common';

/**
 * The project lifecycle, as data (AGENTS.md A-11, ADR-063).
 *
 * ```
 *   create
 *   ─────► DRAFT ──requestApproval──► PENDING_APPROVAL ──(all granted)──► APPROVED ──start──► IN_PROGRESS ──complete──► COMPLETED
 *            ▲                             │ (any rejected)
 *            │                             ▼
 *            └────────resubmit──── CHANGES_REQUESTED
 *
 *   DRAFT | PENDING_APPROVAL | CHANGES_REQUESTED | APPROVED ──cancel(reason)──► CANCELLED
 * ```
 *
 * ## Only part of this is reachable in CON-001 PR 1
 *
 * PR 1 ships `create`, `update` and `cancel`. The approval edges
 * (`PENDING_APPROVAL`, `APPROVED`, `CHANGES_REQUESTED`), `start` and
 * `complete` arrive with PR 2, driven by `approval_policy` rows rather than by
 * code (ADR-023, Q-70, Q-71). The whole table is here anyway so the database
 * enum, the published contract and the cancel rule are written once against
 * the lifecycle the design note fixed, and so PR 2 adds commands, not states.
 *
 * ## What is absent, and why
 *
 *   TENDERING / CONTRACTED   A tender is its own aggregate (`docs/03` § 3.3,
 *                            CON-002). Folding its states into the project
 *                            would lock both behind one row.
 *   SETTLED                  Settlement belongs to contract and economic
 *                            (`docs/04` § 4.12 "داخل نیست").
 *   SUSPENDED / ON_HOLD      No document names a pause, or who may order one.
 *   automatic transitions    None. Nothing here moves on a timer, a threshold
 *                            or silence (ADR-043, Q-73).
 *
 * ## Terminality
 *
 * `COMPLETED` and `CANCELLED` have no outgoing edges. `IN_PROGRESS` cannot be
 * cancelled until Q-71 says what stopping an executing project means.
 */

export const PROJECT_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type ProjectStateName = (typeof PROJECT_STATES)[number];

export const PROJECT_TRANSITIONS: Readonly<Record<ProjectStateName, readonly ProjectStateName[]>> =
  {
    DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'CHANGES_REQUESTED', 'CANCELLED'],
    CHANGES_REQUESTED: ['PENDING_APPROVAL', 'CANCELLED'],
    APPROVED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED'],
    COMPLETED: [],
    CANCELLED: [],
  } as const;

export const TERMINAL_PROJECT_STATES: readonly ProjectStateName[] = ['COMPLETED', 'CANCELLED'];

/**
 * States in which the project's own fields and its needs may change.
 *
 * Once a project is waiting for approval, what is being approved must stay
 * still; once approved, changing it would change something nobody approved.
 */
export const EDITABLE_PROJECT_STATES: readonly ProjectStateName[] = ['DRAFT', 'CHANGES_REQUESTED'];

/**
 * Every state `cancel` may leave, by the lifecycle.
 *
 * `CONSTRUCTION_CANCELLABLE_STATES` narrows this per deployment (Q-69). It can
 * never widen it: a configured state outside this list stops the service at
 * startup rather than inventing an edge the lifecycle does not have.
 */
export const CANCELLABLE_BY_LIFECYCLE: readonly ProjectStateName[] = PROJECT_STATES.filter(
  (state) => PROJECT_TRANSITIONS[state].includes('CANCELLED'),
);

export function isTerminalProjectState(state: ProjectStateName): boolean {
  return TERMINAL_PROJECT_STATES.includes(state);
}

export function isEditableProjectState(state: ProjectStateName): boolean {
  return EDITABLE_PROJECT_STATES.includes(state);
}

export function canTransitionProject(from: ProjectStateName, to: ProjectStateName): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition with the platform's business-rule code.
 *
 * `422` rather than `409`: the request is well-formed and the caller may make
 * it — the project is simply not in a state where it means anything, and a
 * retry will not change that. A stale `expectedVersion` is the `409`.
 */
export function assertProjectTransition(
  projectId: string,
  from: ProjectStateName,
  to: ProjectStateName,
): void {
  if (canTransitionProject(from, to)) return;

  throw RastaError.businessRule(
    isTerminalProjectState(from)
      ? `Project ${projectId} is ${from.toLowerCase()} and cannot change state`
      : `Project ${projectId} cannot move from ${from} to ${to}`,
    { projectId, from, to },
  );
}

/** Refuses a change to a project that is no longer editable. */
export function assertProjectEditable(projectId: string, state: ProjectStateName): void {
  if (isEditableProjectState(state)) return;

  throw RastaError.businessRule(
    `Project ${projectId} is ${state} and can no longer be edited; ` +
      `only a project in ${EDITABLE_PROJECT_STATES.join(' or ')} can change`,
    { projectId, state },
  );
}

/**
 * Refuses a cancellation this deployment does not allow.
 *
 * Two questions, asked in order: does the lifecycle have the edge at all, and
 * has this deployment kept it (`CONSTRUCTION_CANCELLABLE_STATES`, Q-69).
 */
export function assertProjectCancellable(
  projectId: string,
  from: ProjectStateName,
  configured: readonly ProjectStateName[],
): void {
  assertProjectTransition(projectId, from, 'CANCELLED');
  if (configured.includes(from)) return;

  throw RastaError.businessRule(
    `Project ${projectId} cannot be cancelled while ${from} in this deployment`,
    { projectId, from, cancellableStates: [...configured] },
  );
}
