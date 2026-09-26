import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import {
  SCORE_CENTIS_MAX,
  WEIGHT_TOTAL_BP,
  type PerformanceComponent,
  type ScoreStatus,
} from './components';

/**
 * One computed snapshot, with all of ADR-052 § 8's provenance (step 4).
 *
 * Storage shape only. Nothing here computes a score: the calculation engine
 * is step 6, and it will hand this module a finished result to validate and
 * store.
 */
export interface ScoreComponentInput {
  component: PerformanceComponent;
  configuredWeightBp: number;
  /** Null when the component had no data — absent, never 0 (ADR-052 § 5). */
  effectiveWeightBp: number | null;
  componentScoreCentis: number | null;
  sampleCount: number;
}

export interface ScoreSnapshotInput {
  /** The supplier organization scored — the row's tenant. */
  organizationId: string;
  formulaVersionId: string;
  formulaVersion: number;
  windowStart: Date;
  windowEnd: Date;
  status: ScoreStatus;
  scoreCentis: number | null;
  eligibleSampleCount: number;
  coverageBp: number;
  components: readonly ScoreComponentInput[];
  sourceEventIds: readonly string[];
  correlationId: string;
}

/**
 * The effective weight of a component, for display: half-up of
 * `configured × 10 000 ÷ coverage`, in integers (PM ruling on the column
 * shape). The exact value is the stored pair `(configuredWeightBp, coverageBp)`;
 * the rounded ones need not sum to 10 000.
 */
export function effectiveWeightBp(configuredWeightBp: number, coverageBp: number): number {
  if (coverageBp <= 0) {
    throw new RangeError('coverage must be positive to renormalise a weight');
  }
  const numerator = BigInt(configuredWeightBp) * BigInt(WEIGHT_TOTAL_BP);
  const denominator = BigInt(coverageBp);
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/**
 * ADR-052 § 7: a score leaves this service as a two-decimal string ("87.50"),
 * like money, so no consumer turns it into a float.
 */
export function formatScoreCentis(scoreCentis: number): string {
  if (!Number.isSafeInteger(scoreCentis) || scoreCentis < 0 || scoreCentis > SCORE_CENTIS_MAX) {
    throw new RangeError(`scoreCentis must be a whole number in 0..${SCORE_CENTIS_MAX}`);
  }
  const whole = Math.trunc(scoreCentis / 100);
  const fraction = String(scoreCentis % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * The version-independent rules of a snapshot. The database also checks the
 * ones that need the formula version (thresholds, the weighted component set)
 * at commit.
 */
export function scoreSnapshotProblems(input: ScoreSnapshotInput): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const problem = (path: string, message: string): void => {
    problems.push({ path, message });
  };

  if (!(input.windowStart < input.windowEnd)) {
    problem('windowStart', 'the window is half-open [start, end) and must not be empty');
  }

  if (input.status === 'PUBLISHED') {
    if (!isIntIn(input.scoreCentis, 0, SCORE_CENTIS_MAX)) {
      problem(
        'scoreCentis',
        `a PUBLISHED snapshot has a whole-number score in 0..${SCORE_CENTIS_MAX}`,
      );
    }
  } else if (input.scoreCentis !== null) {
    problem('scoreCentis', `${input.status} carries no score — not 0, not anything`);
  }

  if (!isIntIn(input.eligibleSampleCount, 0, Number.MAX_SAFE_INTEGER)) {
    problem('eligibleSampleCount', 'must be a whole number');
  }
  if (!isIntIn(input.coverageBp, 0, WEIGHT_TOTAL_BP)) {
    problem('coverageBp', `must be a whole number of basis points in 0..${WEIGHT_TOTAL_BP}`);
  }

  const seen = new Set<string>();
  let availableBp = 0;
  input.components.forEach((row, index) => {
    const path = `components[${index}]`;
    if (seen.has(row.component)) problem(`${path}.component`, `${row.component} appears twice`);
    seen.add(row.component);

    if (!isIntIn(row.configuredWeightBp, 1, WEIGHT_TOTAL_BP)) {
      problem(`${path}.configuredWeightBp`, 'must be the version’s weight, 1..10000 bp');
    }
    if (!isIntIn(row.sampleCount, 0, Number.MAX_SAFE_INTEGER)) {
      problem(`${path}.sampleCount`, 'must be a whole number');
    }

    const absent = row.effectiveWeightBp === null && row.componentScoreCentis === null;
    const present = row.effectiveWeightBp !== null && row.componentScoreCentis !== null;
    if (!absent && !present) {
      problem(path, 'an absent component has neither weight nor score; a present one has both');
      return;
    }
    if (present) {
      availableBp += row.configuredWeightBp;
      if (!isIntIn(row.componentScoreCentis, 0, SCORE_CENTIS_MAX)) {
        problem(`${path}.componentScoreCentis`, `must be a whole number in 0..${SCORE_CENTIS_MAX}`);
      }
    }
  });

  if (availableBp !== input.coverageBp) {
    problem(
      'coverageBp',
      `must equal the configured weight of the available components (${availableBp})`,
    );
  } else if (input.coverageBp > 0) {
    input.components.forEach((row, index) => {
      if (
        row.effectiveWeightBp !== null &&
        row.effectiveWeightBp !== effectiveWeightBp(row.configuredWeightBp, input.coverageBp)
      ) {
        problem(
          `components[${index}].effectiveWeightBp`,
          'must be the renormalised configured weight',
        );
      }
    });
  }

  if (input.status === 'PUBLISHED' && availableBp === 0) {
    problem('status', 'a PUBLISHED snapshot rests on at least one available component');
  }

  if (new Set(input.sourceEventIds).size !== input.sourceEventIds.length) {
    problem('sourceEventIds', 'names a source event twice');
  }
  if (!/\S/.test(input.organizationId)) problem('organizationId', 'must not be blank');
  if (!/\S/.test(input.correlationId)) problem('correlationId', 'must not be blank');

  return problems;
}

export function assertValidScoreSnapshot(input: ScoreSnapshotInput): void {
  const problems = scoreSnapshotProblems(input);
  if (problems.length > 0) {
    throw RastaError.validation(problems, 'The score snapshot is not valid');
  }
}
