import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  ATTRIBUTED_COMPONENTS,
  OUTCOME_KINDS,
  PERFORMANCE_COMPONENTS,
  RESPONSIBILITY_ATTRIBUTIONS,
  type OutcomeKind,
  type PerformanceComponent,
  type ResponsibilityAttribution,
} from './components';

/**
 * One fact to count toward a supplier's performance (ADR-052 step 3).
 *
 * The shape the step-5 consumers will build from a source event. Raw facts
 * only — a rating, a promise, a delivery, an attribution — never a score: the
 * formula version decides how a fact becomes 0..100, so a new version can
 * re-read the same history (ADR-052 § 12).
 */
export interface PerformanceEventInput {
  /** The supplier organization the fact is about — the row's tenant. */
  organizationId: string;
  sourceEventId: string;
  sourceEventName: string;
  component: PerformanceComponent;
  outcomeKind: OutcomeKind;
  outcomeKey: string;
  responsibility: ResponsibilityAttribution | null;
  rating: number | null;
  promisedAt: Date | null;
  deliveredAt: Date | null;
  compensatesSourceEventId: string | null;
  occurredAt: Date;
  correlationId: string;
}

/** Rating bounds of marketplace's `REVIEW_SUBMITTED` contract (1..5). */
export const SOURCE_RATING_MIN = 1;
export const SOURCE_RATING_MAX = 5;

function notBlank(value: string): boolean {
  return /\S/.test(value);
}

/**
 * Every rule the table's CHECKs also enforce, reported together.
 *
 * The database is the authority; this is so a consumer can dead-letter a
 * malformed fact with a reason instead of a driver error.
 */
export function performanceEventProblems(input: PerformanceEventInput): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const problem = (path: string, message: string): void => {
    problems.push({ path, message });
  };

  for (const field of [
    'organizationId',
    'sourceEventId',
    'sourceEventName',
    'outcomeKey',
    'correlationId',
  ] as const) {
    if (!notBlank(input[field])) problem(field, 'must not be blank');
  }

  if (!(PERFORMANCE_COMPONENTS as readonly string[]).includes(input.component)) {
    problem('component', 'is not one of the ADR-052 components');
  } else if (input.component === 'QUALITY') {
    problem('component', 'QUALITY has no producer until docs/24 Q-56 is answered');
  }
  if (!(OUTCOME_KINDS as readonly string[]).includes(input.outcomeKind)) {
    problem('outcomeKind', 'must be ORDER or REPAIR_ORDER');
  }

  const attributed = (ATTRIBUTED_COMPONENTS as readonly string[]).includes(input.component);
  if (attributed && input.responsibility === null) {
    problem('responsibility', `is required for ${input.component}`);
  } else if (!attributed && input.responsibility !== null) {
    problem('responsibility', `is not a fact of ${input.component}`);
  } else if (
    input.responsibility !== null &&
    !(RESPONSIBILITY_ATTRIBUTIONS as readonly string[]).includes(input.responsibility)
  ) {
    problem('responsibility', 'is outside the closed set of rule 13');
  }

  if (input.component === 'CUSTOMER_SATISFACTION') {
    if (
      input.rating === null ||
      !Number.isSafeInteger(input.rating) ||
      input.rating < SOURCE_RATING_MIN ||
      input.rating > SOURCE_RATING_MAX
    ) {
      problem('rating', `must be a whole number in ${SOURCE_RATING_MIN}..${SOURCE_RATING_MAX}`);
    }
  } else if (input.rating !== null) {
    problem('rating', `is not a fact of ${input.component}`);
  }

  const timeSides = [input.promisedAt, input.deliveredAt].filter((side) => side !== null).length;
  if (input.component === 'ON_TIME' && timeSides !== 1) {
    problem('promisedAt', 'an ON_TIME fact carries exactly one of promisedAt or deliveredAt');
  } else if (input.component !== 'ON_TIME' && timeSides !== 0) {
    problem('promisedAt', `is not a fact of ${input.component}`);
  }

  if (input.compensatesSourceEventId === input.sourceEventId) {
    problem('compensatesSourceEventId', 'a fact cannot compensate itself');
  }

  return problems;
}

export function assertValidPerformanceEvent(input: PerformanceEventInput): void {
  const problems = performanceEventProblems(input);
  if (problems.length > 0) {
    throw RastaError.validation(problems, 'The performance event is not valid');
  }
}

/**
 * How an attributed fact takes part in a component (ADR-052 § 4, § 5).
 *
 *   SUPPLIER      counted, against the supplier;
 *   BUYER         counted, and never as the supplier's fault;
 *   PLATFORM      counted, and never as the supplier's fault;
 *   UNDETERMINED  **not counted** — excluded from the denominator, never
 *                 turned into zero. "We could not tell" is not "it was bad".
 *
 * Only the classification lives here; how counted facts become a component
 * score is the calculation engine (step 6).
 */
export type AttributionEffect = 'AGAINST_SUPPLIER' | 'NOT_AGAINST_SUPPLIER' | 'EXCLUDED';

export function attributionEffect(responsibility: ResponsibilityAttribution): AttributionEffect {
  switch (responsibility) {
    case 'SUPPLIER':
      return 'AGAINST_SUPPLIER';
    case 'BUYER':
    case 'PLATFORM':
      return 'NOT_AGAINST_SUPPLIER';
    case 'UNDETERMINED':
      return 'EXCLUDED';
  }
}

/** Whether an attributed fact enters the denominator at all. */
export function countsTowardDenominator(responsibility: ResponsibilityAttribution): boolean {
  return attributionEffect(responsibility) !== 'EXCLUDED';
}
