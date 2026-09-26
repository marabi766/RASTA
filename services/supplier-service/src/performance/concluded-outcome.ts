import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { OUTCOME_KINDS, type OutcomeKind } from './components';

/**
 * An order that concluded (ADR-052 step 5, `performance_concluded_outcome`).
 *
 * Not a performance fact: it belongs to no component and carries no weight.
 * It is recorded because one answer to docs/24 Q-78 — "all orders that
 * finished in the window" — needs the count of concluded orders, and a
 * history not recorded now cannot be rebuilt from a topic that no longer
 * retains it. Under Q-78's other answers it is never read. Recording it
 * decides nothing.
 *
 * Only `ORDER_COMPLETED` produces one today. A cancellation is also a
 * conclusion, and is already recorded — as a CANCELLATION_ABSENCE fact.
 */
export interface ConcludedOutcomeInput {
  /** The supplier organization whose order concluded — the row's tenant. */
  organizationId: string;
  sourceEventId: string;
  sourceEventName: string;
  outcomeKind: OutcomeKind;
  outcomeKey: string;
  occurredAt: Date;
  correlationId: string;
}

/** Every rule the table's CHECKs also enforce, reported together. */
export function concludedOutcomeProblems(input: ConcludedOutcomeInput): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  for (const field of [
    'organizationId',
    'sourceEventId',
    'sourceEventName',
    'outcomeKey',
    'correlationId',
  ] as const) {
    if (!/\S/.test(input[field])) problems.push({ path: field, message: 'must not be blank' });
  }
  if (!(OUTCOME_KINDS as readonly string[]).includes(input.outcomeKind)) {
    problems.push({ path: 'outcomeKind', message: 'must be ORDER or REPAIR_ORDER' });
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    problems.push({ path: 'occurredAt', message: 'must be a valid time' });
  }
  return problems;
}

export function assertValidConcludedOutcome(input: ConcludedOutcomeInput): void {
  const problems = concludedOutcomeProblems(input);
  if (problems.length > 0) {
    throw RastaError.validation(problems, 'The concluded outcome is not valid');
  }
}
