/**
 * The decision rule behind the "time to the answer" tests: does one kind of
 * request take measurably longer than another, on a machine that is doing other
 * things?
 *
 * Compared before (task 302): the median of 30 held times against the median
 * of 30 fresh times, within max(5 ms, 25 %). Two such medians are unstable when
 * the noise is lumpy: on a loaded runner a request is either quick or caught by
 * a pause of tens of milliseconds, and when the two kinds are about equally
 * often caught, which side a median falls on is a coin toss — a gap of 6–7 ms
 * between two series of identical work (main CI 41398014058, PR #363 run
 * 41392580518; locally, a fresh-against-fresh control did the same). The bound
 * fires on weather, so it could only be kept by widening it, which blinds it.
 *
 * Now: PAIRS. Each pair is one request of each kind, back to back, in an order
 * chosen at random, and what is looked at is the difference of the two,
 * `held − fresh`. If the kinds take the same time, whatever the machine does,
 * the sign of that difference is the order's coin: the two requests are
 * interchangeable and the order is random, so P(difference > 0) = P(difference
 * < 0) ≤ ½ for every noise there is — spikes, bimodal, heavy tails, a busy
 * neighbour — with no assumption about its size. Hence an exact test:
 *
 *   - if at least `requiredAgreeing(pairs)` of the pairs have the difference
 *     on the same side, a coin that fair would do that less than once in two
 *     million times (the tail of Binomial(pairs, ½), per side);
 *   - and the median difference is at least `floorMs` (a real, not a merely
 *     certain, difference: the exact statements next to the clock tests are
 *     for anything smaller).
 *
 * Both → the kinds differ. The sign does not care how big a spike is, so one
 * paused request moves the count by one; the noise decides only how large a
 * delay must be before the count gets there, never whether the test can fail
 * on equal work. A delay on every answer of one kind, as a sleep, a hash or a
 * call to something else would be, is seen from `floorMs` up on a quiet
 * machine and from about twice the noise's spread on a loud one. A delay on
 * only some of the answers is not (the same as before): the exact statements
 * are for that.
 */

export const TIMING_FLOOR_MS = 2;

/** Per side; both sides are looked at, so one cell is wrongly condemned < 1 in a million. */
export const TIMING_ALPHA_PER_SIDE = 5e-7;

/**
 * The smallest count c with P(Binomial(pairs, ½) ≥ c) ≤ alpha: how many of the
 * pairs must agree on a side before fair coins are too unlikely an
 * explanation. `pairs + 1` when even all of them agreeing is not enough.
 */
export function requiredAgreeing(pairs: number, alpha = TIMING_ALPHA_PER_SIDE): number {
  if (!Number.isInteger(pairs) || pairs < 1)
    throw new RangeError('pairs must be a positive integer');
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  // pmf(k) = C(pairs, k) / 2^pairs, built up from k = pairs downwards (the
  // upper tail is what is summed), in doubles: exact enough far beyond 1e-7
  // for the sizes used (≤ 1000 pairs; 2^-1000 is still a normal double).
  let pmf = Math.pow(0.5, pairs);
  const pmfs: number[] = [pmf];
  for (let k = 0; k < pairs; k += 1) {
    pmf = (pmf * (pairs - k)) / (k + 1);
    pmfs.push(pmf);
  }
  let tail = 0;
  let required = pairs + 1;
  for (let k = pairs; k >= 0; k -= 1) {
    tail += pmfs[k]!;
    if (tail > alpha) break;
    required = k;
  }
  return required;
}

export interface TimingVerdict {
  pairs: number;
  /** Pairs in which the second kind (`held`) took longer / shorter. */
  slower: number;
  faster: number;
  /** The median of `held − fresh`, ms. */
  medianDifferenceMs: number;
  required: number;
  differs: boolean;
}

const medianOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * `differences[i]` = the held time minus the fresh time of the i-th pair.
 * Ties count for neither side (they make the test harder to fail, never easier).
 */
export function compareTimings(
  differences: readonly number[],
  floorMs = TIMING_FLOOR_MS,
  alpha = TIMING_ALPHA_PER_SIDE,
): TimingVerdict {
  const pairs = differences.length;
  const required = requiredAgreeing(pairs, alpha);
  const slower = differences.filter((difference) => difference > 0).length;
  const faster = differences.filter((difference) => difference < 0).length;
  const medianDifferenceMs = medianOf([...differences]);
  const differs =
    (slower >= required && medianDifferenceMs >= floorMs) ||
    (faster >= required && medianDifferenceMs <= -floorMs);
  return { pairs, slower, faster, medianDifferenceMs, required, differs };
}

export { medianOf as median };
