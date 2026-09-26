import { RastaError } from '@rasta/nest-common';

/**
 * The progress-report lifecycle (Q-72, provisional).
 *
 * ```
 *   draft               submit
 *   ─────► DRAFT ──────────────────► SUBMITTED  (terminal, immutable)
 *            │
 *            └──── discard ────────► DISCARDED  (terminal)
 * ```
 *
 * No review or acceptance step: no document names who would accept a report
 * (Q-72). A draft is not edited — discard it and draft again; both are
 * recorded. Submission is allowed only while the project is IN_PROGRESS.
 */

export const PROGRESS_STATES = ['DRAFT', 'SUBMITTED', 'DISCARDED'] as const;
export type ProgressStateName = (typeof PROGRESS_STATES)[number];

export const PROGRESS_TRANSITIONS: Readonly<
  Record<ProgressStateName, readonly ProgressStateName[]>
> = {
  DRAFT: ['SUBMITTED', 'DISCARDED'],
  SUBMITTED: [],
  DISCARDED: [],
} as const;

/** Full progress, in basis points: the completion guard (`docs/08` § 8.3, Q-71). */
export const FULL_PROGRESS_BASIS_POINTS = 10_000;

export function canTransitionProgress(from: ProgressStateName, to: ProgressStateName): boolean {
  return PROGRESS_TRANSITIONS[from].includes(to);
}

export function assertProgressTransition(
  reportId: string,
  from: ProgressStateName,
  to: ProgressStateName,
): void {
  if (canTransitionProgress(from, to)) return;
  throw RastaError.businessRule(
    `Progress report ${reportId} is ${from.toLowerCase()} and cannot move to ${to}`,
    { reportId, from, to },
  );
}
