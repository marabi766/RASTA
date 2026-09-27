import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  PERFORMANCE_COMPONENTS,
  SCORE_CENTIS_MAX,
  WEIGHT_TOTAL_BP,
  type FormulaStatus,
  type PerformanceComponent,
} from './components';

/**
 * A formula version as somebody proposes it, before it is stored (ADR-052 § 3).
 *
 * Every number here is configuration the operator supplies. None has a default
 * in code: ADR-052's initial values (30/25/20/15/10, 180 days, 5 samples,
 * 5000 bp) are the first version an operator records, not constants this
 * service assumes.
 */
export interface FormulaDraftInput {
  windowDays: number;
  minSampleCount: number;
  minCoverageBp: number;
  /** ADR-052 § 7: two points of a linear, increasing rating → 0..100 line. */
  ratingMapping: {
    scaleMin: number;
    scaleMax: number;
    minScoreCentis: number;
    maxScoreCentis: number;
  };
  weights: readonly { component: PerformanceComponent; weightBp: number }[];
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Checks a draft against every rule the database also enforces, and reports
 * all of them at once.
 *
 * The database is the authority — `ck_formula_*` and the deferred 100% trigger
 * refuse the same drafts — and this is the courtesy in front of it: one
 * `VALIDATION_FAILED` naming each problem instead of the first constraint
 * violation a driver happens to surface.
 */
export function formulaDraftProblems(input: FormulaDraftInput): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const problem = (path: string, message: string): void => {
    problems.push({ path, message });
  };

  if (!isInteger(input.windowDays) || input.windowDays <= 0) {
    problem('windowDays', 'must be a positive whole number of days');
  }
  if (!isInteger(input.minSampleCount) || input.minSampleCount <= 0) {
    problem('minSampleCount', 'must be a positive whole number of distinct outcomes');
  }
  if (
    !isInteger(input.minCoverageBp) ||
    input.minCoverageBp < 0 ||
    input.minCoverageBp > WEIGHT_TOTAL_BP
  ) {
    problem('minCoverageBp', `must be a whole number of basis points in 0..${WEIGHT_TOTAL_BP}`);
  }

  const { scaleMin, scaleMax, minScoreCentis, maxScoreCentis } = input.ratingMapping;
  if (!isInteger(scaleMin) || !isInteger(scaleMax) || scaleMin >= scaleMax) {
    problem('ratingMapping', 'the rating scale needs two whole-number ends, low below high');
  }
  for (const [field, value] of [
    ['minScoreCentis', minScoreCentis],
    ['maxScoreCentis', maxScoreCentis],
  ] as const) {
    if (!isInteger(value) || value < 0 || value > SCORE_CENTIS_MAX) {
      problem(`ratingMapping.${field}`, `must be a whole number in 0..${SCORE_CENTIS_MAX}`);
    }
  }
  if (isInteger(minScoreCentis) && isInteger(maxScoreCentis) && minScoreCentis >= maxScoreCentis) {
    problem('ratingMapping', 'a better rating must map to a higher score');
  }

  const seen = new Set<string>();
  let total = 0;
  input.weights.forEach((weight, index) => {
    const path = `weights[${index}]`;
    if (!(PERFORMANCE_COMPONENTS as readonly string[]).includes(weight.component)) {
      problem(`${path}.component`, 'is not one of the ADR-052 components');
    } else if (seen.has(weight.component)) {
      problem(`${path}.component`, `${weight.component} is weighted twice`);
    }
    seen.add(weight.component);

    if (!isInteger(weight.weightBp) || weight.weightBp < 1 || weight.weightBp > WEIGHT_TOTAL_BP) {
      problem(
        `${path}.weightBp`,
        `must be a whole number of basis points in 1..${WEIGHT_TOTAL_BP}`,
      );
    } else {
      total += weight.weightBp;
    }
  });
  if (total !== WEIGHT_TOTAL_BP) {
    problem('weights', `must sum to exactly ${WEIGHT_TOTAL_BP} bp; they sum to ${total}`);
  }

  return problems;
}

export function assertValidFormulaDraft(input: FormulaDraftInput): void {
  const problems = formulaDraftProblems(input);
  if (problems.length > 0) {
    throw RastaError.validation(problems, 'The formula version is not valid');
  }
}

/**
 * Whether a version in `status` may be activated.
 *
 * Only a DRAFT. An ACTIVE version is already in force, and a RETIRED one was
 * superseded: bringing it back would silently reinterpret every snapshot taken
 * since under a formula nobody chose again (ADR-052 § 13). A new version with
 * the same weights is the way to say that.
 */
export function assertActivatable(formulaVersion: number, status: FormulaStatus): void {
  if (status !== 'DRAFT') {
    throw RastaError.invalidStateTransition(
      'PerformanceFormulaVersion',
      status,
      'ACTIVE',
      `Performance formula version ${formulaVersion} is ${status}; only a DRAFT is activated`,
    );
  }
}
