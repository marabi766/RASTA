/**
 * The decision rule and the measuring loop behind the "time to the answer"
 * tests: does one kind of request take measurably longer than another, on a
 * machine that is doing other things — and, as important, has the run shown
 * enough to say that it does NOT (task 302; PR #560 r1 F1/F2).
 *
 * PAIRS. Each pair is one request of each kind, back to back, in an order
 * chosen at random, and what is looked at is the difference `held − fresh`.
 * With equal work the two requests of a pair are interchangeable and the order
 * is random, so the difference is symmetric about 0 whatever the machine does
 * (spikes, two modes, heavy tails, a busy neighbour); a constant delay `d` on
 * every held answer moves it to be symmetric about `d`. Its MEDIAN is what is
 * judged, with two distribution-free tools that assume nothing about the
 * noise's size or shape:
 *
 *   - the sign test: how many pairs fall on one side of 0;
 *   - the sign-test confidence interval for the median: between two order
 *     statistics of the sorted differences, the indices from the binomial
 *     tail (for any distribution, P(median above the interval) and P(below)
 *     are each at most the tail).
 *
 * THREE verdicts, and only one of them passes a real case:
 *
 *   - `different`: at least `requiredAgreeing` pairs on one side (fair coins
 *     do that with probability ≤ α) AND the median difference at least
 *     `TIMING_FLOOR_MS` that way.
 *   - `equivalent`: not different, and the whole interval for the median lies
 *     strictly inside ±`TIMING_MIN_DETECTABLE_MS`. A delay that moves the
 *     median by that much or more is called equivalent with probability ≤ β,
 *     whatever the noise: a run that cannot resolve it cannot pass.
 *   - `inconclusive`: neither. Not evidence of equality: the loop measures
 *     more pairs, up to `TIMING_MAX_PAIRS`, and a cell still inconclusive
 *     there FAILS.
 *
 * The sample sizes are the helper's, not the caller's: `classifyTimings`
 * refuses any count that is not one of `TIMING_LOOK_PAIRS` (100, 200 … 600),
 * so no loop setting can make a verdict out of ten pairs, or out of none. The
 * error budgets are split evenly over those looks (Bonferroni), so looking
 * again after an inconclusive answer does not spend more than α and β per
 * cell in total.
 *
 * `measurePairedTimings` is the loop: warm-up pairs, then rounds over every
 * still-unsettled cell in a random order (a slow stretch of the runner falls
 * on every case alike), a pair recorded only once BOTH of its submissions
 * have completed, every completion counted, and each cell classified at each
 * look until it is settled.
 */

/**
 * Δ: the smallest delay on every answer of one kind that the guard MUST
 * detect — and that an `equivalent` verdict rules out at confidence 1 − β.
 * Chosen from CI's measured noise (run 41408789150, the run of this rule's
 * first version): 10–90 % of the pair differences spanned about ±4.5 ms at
 * the service and ±8.5 ms over HTTP. The sign test sees a shift `d` through
 * P(difference + d > 0); at 5 ms that is about 0.8 over HTTP on that noise,
 * which the looks below turn into a `different` verdict well before 600
 * pairs (the positive controls in the clock test prove it on the run's own
 * noise, every run).
 */
export const TIMING_MIN_DETECTABLE_MS = 5;

/** A `different` verdict also needs the median this far from 0 (a real, not a merely certain, difference). */
export const TIMING_FLOOR_MS = 2;

/** False `different` on equal work, per side, per cell, all looks together: < 1 in a million per cell. */
export const TIMING_ALPHA_PER_SIDE = 5e-7;

/**
 * False `equivalent` when the median delay is at least Δ, per cell, all looks
 * together. Small enough that a positive control at exactly Δ is not itself a
 * flake (at 1e-3 it was, 1–3 cells in 4000 in the spec's simulations).
 */
export const TIMING_BETA = 1e-5;

/** The only sample sizes a verdict is given for; the first is the floor no caller can go below. */
export const TIMING_LOOK_PAIRS: readonly number[] = Object.freeze([100, 200, 300, 400, 500, 600]);
export const TIMING_MIN_PAIRS = 100;
export const TIMING_MAX_PAIRS = 600;
export const TIMING_WARM_UP_PAIRS = 10;

/**
 * The smallest count c with P(Binomial(pairs, ½) ≥ c) ≤ tail. `pairs + 1`
 * when even all of them is not enough.
 */
export function binomialUpperTailCount(pairs: number, tail: number): number {
  if (!Number.isInteger(pairs) || pairs < 1)
    throw new RangeError('pairs must be a positive integer');
  if (!(tail > 0 && tail < 1)) throw new RangeError('the tail must be in (0, 1)');
  // pmf(k) = C(pairs, k) / 2^pairs, in doubles: exact enough far beyond 1e-8
  // for the sizes used (≤ 600 pairs; 2^-600 is still a normal double).
  let pmf = Math.pow(0.5, pairs);
  const pmfs: number[] = [pmf];
  for (let k = 0; k < pairs; k += 1) {
    pmf = (pmf * (pairs - k)) / (k + 1);
    pmfs.push(pmf);
  }
  let sum = 0;
  let count = pairs + 1;
  for (let k = pairs; k >= 0; k -= 1) {
    sum += pmfs[k]!;
    if (sum > tail) break;
    count = k;
  }
  return count;
}

export type TimingClass = 'equivalent' | 'different' | 'inconclusive';

export interface TimingVerdict {
  pairs: number;
  /** Pairs in which the held kind took longer / shorter (ties are neither). */
  slower: number;
  faster: number;
  /** The median of `held − fresh`, ms. */
  medianDifferenceMs: number;
  /** Pairs on one side needed for `different` at this look. */
  requiredAgreeing: number;
  /** The interval for the median difference, ms, each end wrong with probability ≤ β / looks. */
  intervalMs: readonly [number, number];
  verdict: TimingClass;
  /** For `different`: which kind was the slower one. */
  slowerKind?: PairKind;
}

const medianOfSorted = (sorted: readonly number[]): number => {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export const median = (values: readonly number[]): number =>
  medianOfSorted([...values].sort((a, b) => a - b));

/** The two counts of a look, computed once per size. */
const countsByPairs = new Map<number, { requiredAgreeing: number; interval: number }>();
const countsFor = (pairs: number) => {
  let counts = countsByPairs.get(pairs);
  if (!counts) {
    const looks = TIMING_LOOK_PAIRS.length;
    counts = {
      requiredAgreeing: binomialUpperTailCount(pairs, TIMING_ALPHA_PER_SIDE / looks),
      interval: binomialUpperTailCount(pairs, TIMING_BETA / looks),
    };
    countsByPairs.set(pairs, counts);
  }
  return counts;
};

/**
 * `differences[i]` = the held time minus the fresh time of the i-th pair, ms.
 * Refuses (RangeError) a count that is not a look size and any value that is
 * not a finite number: nothing it cannot judge is turned into a verdict.
 */
export function classifyTimings(differences: readonly number[]): TimingVerdict {
  const pairs = differences.length;
  if (pairs < TIMING_MIN_PAIRS || !TIMING_LOOK_PAIRS.includes(pairs))
    throw new RangeError(
      `a timing verdict needs one of ${TIMING_LOOK_PAIRS.join(', ')} pairs (at least ${TIMING_MIN_PAIRS}), got ${pairs}`,
    );
  if (
    !differences.every(
      (difference) => typeof difference === 'number' && Number.isFinite(difference),
    )
  )
    throw new RangeError('every pair difference must be a finite number of milliseconds');
  const { requiredAgreeing, interval: c } = countsFor(pairs);
  const slower = differences.filter((difference) => difference > 0).length;
  const faster = differences.filter((difference) => difference < 0).length;
  const sorted = [...differences].sort((a, b) => a - b);
  const medianDifferenceMs = medianOfSorted(sorted);
  // [x(n+1−c), x(c)] with c from the β tail: P(median > x(c)) ≤ P(Bin ≥ c) ≤ β/looks,
  // and the same for the lower end, for any distribution (ties included).
  const intervalMs: readonly [number, number] =
    c > pairs ? [-Infinity, Infinity] : [sorted[pairs - c]!, sorted[c - 1]!];
  const different =
    (slower >= requiredAgreeing && medianDifferenceMs >= TIMING_FLOOR_MS) ||
    (faster >= requiredAgreeing && medianDifferenceMs <= -TIMING_FLOOR_MS);
  const equivalent =
    intervalMs[0] > -TIMING_MIN_DETECTABLE_MS && intervalMs[1] < TIMING_MIN_DETECTABLE_MS;
  const verdict: TimingClass = different ? 'different' : equivalent ? 'equivalent' : 'inconclusive';
  return {
    pairs,
    slower,
    faster,
    medianDifferenceMs,
    requiredAgreeing,
    intervalMs,
    verdict,
    ...(different ? { slowerKind: medianDifferenceMs > 0 ? 'held' : 'fresh' } : {}),
  };
}

export type PairKind = 'fresh' | 'held';

export interface TimingCell {
  readonly name: string;
  /**
   * What the cell must come out as for the run to pass: a real case and a
   * negative control `equivalent`; a positive control (a delay on the held
   * side) `different` with the HELD side the slower — a "difference" the
   * other way round is no detection of the delay.
   */
  readonly expect: 'equivalent' | 'held slower';
}

export interface CellOutcome<C extends TimingCell> {
  cell: C;
  fresh: number[];
  held: number[];
  differences: number[];
  /** The verdict at each look this cell reached, in order. */
  looks: TimingVerdict[];
  final: TimingVerdict;
  /** Submissions of this cell that completed, warm-up included. */
  submissions: number;
}

export interface TimingRun<C extends TimingCell> {
  outcomes: CellOutcome<C>[];
  submissions: number;
}

export interface TimingInstruments {
  now(): number;
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * Measures `cells` pair by pair until each is settled (`equivalent` or
 * `different`) or `TIMING_MAX_PAIRS` is reached. `submit` must resolve only
 * once its submission has been answered (and checked); a pair counts only
 * when both of its submissions have.
 */
export async function measurePairedTimings<C extends TimingCell>(
  cells: readonly C[],
  submit: (cell: C, kind: PairKind) => Promise<void>,
  instruments: TimingInstruments,
): Promise<TimingRun<C>> {
  if (cells.length === 0) throw new RangeError('nothing to measure');
  const outcomes = new Map<C, Omit<CellOutcome<C>, 'final'> & { final?: TimingVerdict }>(
    cells.map((cell) => [
      cell,
      { cell, fresh: [], held: [], differences: [], looks: [], submissions: 0 },
    ]),
  );
  let submissions = 0;
  const pair = async (cell: C) => {
    const outcome = outcomes.get(cell)!;
    const order = instruments.shuffle<PairKind>(['fresh', 'held']);
    if (order.length !== 2 || !order.includes('fresh') || !order.includes('held'))
      throw new Error(
        `${cell.name}: a pair is one fresh and one held submission, not ${order.join(', ')}`,
      );
    const took = {} as Record<PairKind, number>;
    for (const kind of order) {
      const started = instruments.now();
      await submit(cell, kind);
      const elapsed = instruments.now() - started;
      // A real submission takes time: none (or a clock that does not move) is no measurement.
      if (!(Number.isFinite(elapsed) && elapsed > 0))
        throw new Error(`${cell.name}: a ${kind} submission took ${elapsed} ms — not measured`);
      took[kind] = elapsed;
      outcome.submissions += 1;
      submissions += 1;
    }
    return took;
  };

  for (let round = 0; round < TIMING_WARM_UP_PAIRS; round += 1)
    for (const cell of instruments.shuffle(cells)) await pair(cell);

  let active = [...cells];
  let measured = 0;
  for (const look of TIMING_LOOK_PAIRS) {
    for (; measured < look; measured += 1) {
      for (const cell of instruments.shuffle(active)) {
        const { fresh, held } = await pair(cell);
        const outcome = outcomes.get(cell)!;
        outcome.fresh.push(fresh);
        outcome.held.push(held);
        outcome.differences.push(held - fresh);
      }
    }
    for (const cell of active) {
      const outcome = outcomes.get(cell)!;
      const verdict = classifyTimings(outcome.differences);
      outcome.looks.push(verdict);
      outcome.final = verdict;
    }
    active = active.filter((cell) => outcomes.get(cell)!.final!.verdict === 'inconclusive');
    if (active.length === 0) break;
  }
  return {
    outcomes: cells.map((cell) => outcomes.get(cell) as CellOutcome<C>),
    submissions,
  };
}

/**
 * Every cell that did not come out as it must, said plainly. An inconclusive
 * cell is a failure: the run could not show that a Δ delay would have been
 * seen, so it shows nothing about equality.
 */
const cameOutAsItMust = ({ cell, final }: CellOutcome<TimingCell>) =>
  cell.expect === 'equivalent'
    ? final.verdict === 'equivalent'
    : final.verdict === 'different' && final.slowerKind === 'held';

export function timingFailures<C extends TimingCell>(run: TimingRun<C>): string[] {
  return run.outcomes
    .filter((outcome) => !cameOutAsItMust(outcome))
    .map(({ cell, final }) => {
      const at = `after ${final.pairs} pairs: median ${final.medianDifferenceMs.toFixed(2)} ms, interval ${final.intervalMs[0].toFixed(2)}…${final.intervalMs[1].toFixed(2)} ms, held slower in ${final.slower} and faster in ${final.faster} (${final.requiredAgreeing} on one side for "different")`;
      if (final.verdict === 'inconclusive')
        return `${cell.name}: INCONCLUSIVE ${at} — the run was too noisy to show that a ${TIMING_MIN_DETECTABLE_MS} ms delay would be seen; this does not pass`;
      const found =
        final.verdict === 'different' ? `DIFFERENT, ${final.slowerKind} slower` : 'EQUIVALENT';
      return `${cell.name}: ${found}, must be ${cell.expect}, ${at}`;
    });
}
