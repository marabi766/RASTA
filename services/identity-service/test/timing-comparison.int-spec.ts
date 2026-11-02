import {
  binomialUpperTailCount,
  classifyTimings,
  measurePairedTimings,
  median,
  timingFailures,
  TIMING_ALPHA_PER_SIDE,
  TIMING_BETA,
  TIMING_FLOOR_MS,
  TIMING_LOOK_PAIRS,
  TIMING_MAX_PAIRS,
  TIMING_MIN_DETECTABLE_MS,
  TIMING_MIN_PAIRS,
  TIMING_WARM_UP_PAIRS,
  type PairKind,
  type TimingCell,
  type TimingVerdict,
} from './timing-comparison';

/**
 * The rule and the loop that registration-acknowledgement.int-spec.ts judges
 * the clock by (task 302; PR #560 r1 F1/F2), on their own: no database, no
 * service, a seeded generator and a clock of the test's own. What they have to
 * be: never wrong on equal work whatever the noise, never passing a delay of
 * Δ or more however noisy the run (not enough evidence is a failure, not
 * equality), and no verdict from a measurement that did not happen.
 */

/** mulberry32: a small seeded generator, so the trials are the same on every run. */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Noise = (random: () => number) => number;
/** An exponential tail of the given mean: pair differences of two of them are Laplace, 10–90 % at ±1.61 × mean. */
const exponentialTail =
  (base: number, mean: number): Noise =>
  (random) =>
    base - Math.log(random() + 1e-12) * mean;
const NOISES: Record<string, Noise> = {
  // A quiet machine: 6 ms and a millisecond or so.
  quiet: (random) => 6 + (random() + random() + random() - 1.5),
  // A loaded runner: half the requests are caught by a pause of 15–25 ms — the
  // shape on which two medians flip between the modes (the CI failures), and
  // the one PR #560 r1 F1 reproduced the missed delays with.
  'bimodal, half caught by a pause': (random) =>
    6 + random() * 2 + (random() < 0.5 ? 15 + random() * 10 : 0),
  // Rare, long stalls.
  'heavy tail': (random) => 6 + random() + (random() < 0.1 ? -Math.log(random() + 1e-9) * 30 : 0),
  // CI as measured (run 41408789150): pair differences 10–90 % at about ±4.5 ms
  // at the service and ±8.5 ms over HTTP.
  'CI, service': exponentialTail(3, 2.8),
  'CI, HTTP': exponentialTail(10, 5.3),
  // Twice CI's HTTP spread: where the 600 pairs are about used up.
  'twice CI, HTTP': exponentialTail(10, 10.6),
};

/** `pairs` pair differences, order random, `delay` on every held answer — PR #560 r1's generator, unchanged. */
const differences = (noise: Noise, random: () => number, pairs: number, delay: number) =>
  Array.from({ length: pairs }, () => {
    const first = noise(random);
    const second = noise(random);
    // Which of the two was the held one is the coin the rule is built on.
    return random() < 0.5 ? second + delay - first : first + delay - second;
  });

/** One cell as the loop runs it: a look, and more pairs while it is inconclusive, up to the last look. */
const sequential = (noise: Noise, random: () => number, delay: number): TimingVerdict => {
  const measured: number[] = [];
  let verdict: TimingVerdict | undefined;
  for (const look of TIMING_LOOK_PAIRS) {
    measured.push(...differences(noise, random, look - measured.length, delay));
    verdict = classifyTimings(measured);
    if (verdict.verdict !== 'inconclusive') break;
  }
  return verdict!;
};
const tally = (verdicts: TimingVerdict[]) =>
  verdicts.reduce((counts, { verdict }) => ({ ...counts, [verdict]: counts[verdict] + 1 }), {
    equivalent: 0,
    different: 0,
    inconclusive: 0,
  });
const cellsOf = (noise: Noise, seed: number, delay: number, count = 4000) => {
  const random = generator(seed);
  return tally(Array.from({ length: count }, () => sequential(noise, random, delay)));
};

/** The exact upper tail P(Binomial(n, ½) ≥ from), by hand. */
const tail = (n: number, from: number) => {
  let term = Math.pow(0.5, n);
  let sum = from === 0 ? term : 0;
  for (let k = 0; k < n; k += 1) {
    term = (term * (n - k)) / (k + 1);
    if (k + 1 >= from) sum += term;
  }
  return sum;
};

describe('the rule for "does one kind of request take longer than the other" (task 302, PR #560 r1)', () => {
  it('is fixed by the helper, not the caller: Δ 5 ms, floor 2 ms, α 5e-7, β 1e-5, looks at 100 … 600 pairs after 10 warm-up', () => {
    expect({
      TIMING_MIN_DETECTABLE_MS,
      TIMING_FLOOR_MS,
      TIMING_ALPHA_PER_SIDE,
      TIMING_BETA,
      TIMING_LOOK_PAIRS,
      TIMING_MIN_PAIRS,
      TIMING_MAX_PAIRS,
      TIMING_WARM_UP_PAIRS,
    }).toEqual({
      TIMING_MIN_DETECTABLE_MS: 5,
      TIMING_FLOOR_MS: 2,
      TIMING_ALPHA_PER_SIDE: 5e-7,
      TIMING_BETA: 1e-5,
      TIMING_LOOK_PAIRS: [100, 200, 300, 400, 500, 600],
      TIMING_MIN_PAIRS: 100,
      TIMING_MAX_PAIRS: 600,
      TIMING_WARM_UP_PAIRS: 10,
    });
    expect(Object.isFrozen(TIMING_LOOK_PAIRS)).toBe(true);
  });

  it('refuses to judge what it cannot: fewer than 100 pairs, a count that is not a look, a value that is not a finite time', () => {
    for (const pairs of [0, 1, 10, 99, 150, 601, 1000])
      expect(() => classifyTimings(Array(pairs).fill(50))).toThrow(RangeError);
    for (const bad of [NaN, Infinity, -Infinity, undefined as unknown as number])
      expect(() => classifyTimings([...Array(99).fill(0), bad])).toThrow(RangeError);
    expect(() => binomialUpperTailCount(0, 0.01)).toThrow(RangeError);
    expect(() => binomialUpperTailCount(10, 0)).toThrow(RangeError);
  });

  it('takes its counts from the exact binomial tail, the budgets split over the six looks', () => {
    const looks = TIMING_LOOK_PAIRS.length;
    for (const n of TIMING_LOOK_PAIRS) {
      for (const budget of [TIMING_ALPHA_PER_SIDE / looks, TIMING_BETA / looks]) {
        const count = binomialUpperTailCount(n, budget);
        expect(tail(n, count)).toBeLessThanOrEqual(budget);
        expect(tail(n, count - 1)).toBeGreaterThan(budget);
      }
    }
    expect(
      TIMING_LOOK_PAIRS.map((n) => classifyTimings(Array(n).fill(0)).requiredAgreeing),
    ).toEqual([77, 138, 196, 253, 309, 365]);
    // The interval for the median is [x(n+1−c), x(c)] of the sorted differences.
    const ramp = Array.from({ length: 100 }, (_, i) => i - 50);
    const c = binomialUpperTailCount(100, TIMING_BETA / looks);
    expect(c).toBe(74);
    expect(classifyTimings(ramp).intervalMs).toEqual([ramp[100 - c], ramp[c - 1]]);
  });

  it('three verdicts: different needs the side count AND the floor; equivalent needs the whole interval inside ±Δ; anything else is inconclusive', () => {
    const pairs = 100;
    // Every pair a hair slower: certain, not a difference of any size, and well inside ±Δ.
    expect(classifyTimings(Array(pairs).fill(TIMING_FLOOR_MS / 4))).toMatchObject({
      slower: pairs,
      verdict: 'equivalent',
    });
    // At the floor, all on one side, in either direction.
    expect(classifyTimings(Array(pairs).fill(TIMING_FLOOR_MS)).verdict).toBe('different');
    expect(classifyTimings(Array(pairs).fill(-TIMING_FLOOR_MS)).verdict).toBe('different');
    // One pair short of the count, the rest close by: a coin could do that — and
    // the interval reaches 10 ms, so it is not shown equal either.
    const required = classifyTimings(Array(pairs).fill(0)).requiredAgreeing;
    const short = [...Array(required - 1).fill(10), ...Array(pairs - required + 1).fill(-0.1)];
    expect(classifyTimings(short)).toMatchObject({
      slower: required - 1,
      verdict: 'inconclusive',
    });
    const enough = [...Array(required).fill(10), ...Array(pairs - required).fill(-0.1)];
    expect(classifyTimings(enough)).toMatchObject({ slower: required, verdict: 'different' });
    // Balanced, median 0, and an interval that reaches ±Δ exactly: not inside, so not equal.
    const wide = Array.from({ length: pairs }, (_, i) =>
      i % 2 ? TIMING_MIN_DETECTABLE_MS : -TIMING_MIN_DETECTABLE_MS,
    );
    expect(classifyTimings(wide)).toMatchObject({ medianDifferenceMs: 0, verdict: 'inconclusive' });
    // Ties are no side.
    expect(classifyTimings(Array(pairs).fill(0))).toMatchObject({
      slower: 0,
      faster: 0,
      verdict: 'equivalent',
    });
  });

  it.each(Object.keys(NOISES))(
    'equal work comes out equivalent, never different or inconclusive — %s: 2000 cells',
    (name) => {
      expect(cellsOf(NOISES[name]!, 302, 0, 2000)).toEqual({
        equivalent: 2000,
        different: 0,
        inconclusive: 0,
      });
    },
  );

  it.each([
    ...Object.keys(NOISES).map((name) => [name, TIMING_MIN_DETECTABLE_MS] as const),
    ['bimodal, half caught by a pause', -TIMING_MIN_DETECTABLE_MS] as const,
    ['CI, HTTP', -TIMING_MIN_DETECTABLE_MS] as const,
  ])(
    'a delay of exactly Δ on every held answer is different, every time — %s, %d ms: 2000 cells (what the positive controls stand on)',
    (name, delay) => {
      expect(cellsOf(NOISES[name]!, 1302, delay, 2000)).toEqual({
        equivalent: 0,
        different: 2000,
        inconclusive: 0,
      });
    },
  );

  it('PR #560 r1 F1, reproduced: bimodal noise, seed 1302, +5 and +10 ms — the r1 rule passed 2903 and 1876 cells in 4000; this passes none', () => {
    const noise = NOISES['bimodal, half caught by a pause']!;
    // The r1 rule: 100 pairs, "differs" only with ≥ 75 on one side and |median| ≥ 2, otherwise PASS.
    const r1Passes = (delay: number) => {
      const random = generator(1302);
      let passed = 0;
      for (let cell = 0; cell < 4000; cell += 1) {
        const pairs = differences(noise, random, 100, delay);
        const slower = pairs.filter((d) => d > 0).length;
        const faster = pairs.filter((d) => d < 0).length;
        const middle = median(pairs);
        if (!((slower >= 75 && middle >= 2) || (faster >= 75 && middle <= -2))) passed += 1;
      }
      return passed;
    };
    expect([r1Passes(5), r1Passes(10)]).toEqual([2903, 1876]);
    for (const delay of [5, 10])
      expect({ delay, ...cellsOf(noise, 1302, delay) }).toEqual({
        delay,
        equivalent: 0,
        different: 4000,
        inconclusive: 0,
      });
  });

  it('fails closed when the run is too noisy to tell: 4 × CI over HTTP, a Δ delay is never equivalent, and equal work is inconclusive rather than passed', () => {
    const loud = exponentialTail(10, 21.2);
    const delayed = cellsOf(loud, 1302, TIMING_MIN_DETECTABLE_MS, 300);
    expect(delayed.equivalent).toBe(0);
    const equal = cellsOf(loud, 302, 0, 300);
    expect(equal.different).toBe(0);
    // Not all equal cells can be shown equal at this noise: those are failures, as they must be.
    expect(equal.inconclusive).toBeGreaterThan(0);
  });

  it('whereas the medians it replaced were wrong on equal work when half the requests meet a pause', () => {
    const random = generator(302);
    const noise = NOISES['bimodal, half caught by a pause']!;
    let wrong = 0;
    for (let cell = 0; cell < 1000; cell += 1) {
      const fresh = Array.from({ length: 30 }, () => noise(random));
      const held = Array.from({ length: 30 }, () => noise(random));
      const base = median(fresh);
      if (Math.abs(median(held) - base) >= Math.max(5, 0.25 * base)) wrong += 1;
    }
    // Hundreds of cells in a thousand: this is the bug of task 302, not a margin.
    expect(wrong).toBeGreaterThan(200);
  });
});

describe('the measuring loop: a verdict only from measurements that happened (PR #560 r1 F2)', () => {
  type Cell = TimingCell & { delay: number };
  /** A clock of the test's own: a submission takes noise (+ the cell's delay when held), and nothing else moves it. */
  const instruments = (seed: number, noise: Noise) => {
    const random = generator(seed);
    let now = 0;
    const shuffle = <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    const completed: Array<{ cell: string; kind: PairKind }> = [];
    const submit = async (cell: Cell, kind: PairKind) => {
      await Promise.resolve();
      now += noise(random) + (kind === 'held' ? cell.delay : 0);
      completed.push({ cell: cell.name, kind });
    };
    return { instruments: { now: () => now, shuffle }, submit, completed };
  };
  const matrix = (): Cell[] => [
    { name: 'control: fresh against fresh', expect: 'equivalent', delay: 0 },
    { name: 'a held case', expect: 'equivalent', delay: 0 },
    {
      name: `control: fresh against fresh + ${TIMING_MIN_DETECTABLE_MS} ms`,
      expect: 'held slower',
      delay: TIMING_MIN_DETECTABLE_MS,
    },
  ];

  it('on CI-like noise: the controls and the case come out as they must, and every submission is counted — warm-up, both of every pair', async () => {
    const { instruments: clock, submit, completed } = instruments(7, NOISES['CI, HTTP']!);
    const run = await measurePairedTimings(matrix(), submit, clock);

    expect(timingFailures(run)).toEqual([]);
    for (const outcome of run.outcomes) {
      const pairs = outcome.differences.length;
      expect(TIMING_LOOK_PAIRS).toContain(pairs);
      expect(outcome.fresh).toHaveLength(pairs);
      expect(outcome.held).toHaveLength(pairs);
      expect(outcome.submissions).toBe(2 * (TIMING_WARM_UP_PAIRS + pairs));
      expect(completed.filter((c) => c.cell === outcome.cell.name)).toHaveLength(
        outcome.submissions,
      );
      // Fresh and held alike, every pair both.
      expect(
        completed.filter((c) => c.cell === outcome.cell.name && c.kind === 'held'),
      ).toHaveLength(outcome.submissions / 2);
    }
    expect(run.submissions).toBe(completed.length);
  });

  it('a cell measures on while it is inconclusive and fails, said plainly, at the last look', async () => {
    const { instruments: clock, submit } = instruments(11, exponentialTail(10, 60));
    const run = await measurePairedTimings(
      [{ name: 'too loud', expect: 'equivalent', delay: 0 }],
      submit,
      clock,
    );
    const [outcome] = run.outcomes;
    expect(outcome!.looks.map((look) => look.verdict)).toEqual(Array(6).fill('inconclusive'));
    expect(outcome!.differences).toHaveLength(TIMING_MAX_PAIRS);
    expect(timingFailures(run)).toEqual([
      expect.stringMatching(/^too loud: INCONCLUSIVE after 600 pairs.*does not pass$/),
    ]);
  });

  it('a settled cell stops; a delayed "held" kind is condemned', async () => {
    const { instruments: clock, submit } = instruments(13, NOISES.quiet!);
    const run = await measurePairedTimings(
      [{ name: 'a held case, 10 ms slower', expect: 'equivalent', delay: 10 }],
      submit,
      clock,
    );
    expect(run.outcomes[0]!.looks.map((look) => look.verdict)).toEqual(['different']);
    expect(timingFailures(run)).toEqual([
      expect.stringMatching(
        /^a held case, 10 ms slower: DIFFERENT, held slower, must be equivalent, after 100 pairs/,
      ),
    ]);
  });

  it('a skipped measurement cannot pass: a submission that takes no time is refused, and one that skips the delayed work leaves the positive control equivalent, which fails', async () => {
    const { instruments: clock, submit } = instruments(17, NOISES['CI, HTTP']!);
    await expect(measurePairedTimings(matrix(), async () => undefined, clock)).rejects.toThrow(
      /submission took 0 ms — not measured/,
    );
    const skipsTheDelay = (cell: Cell, kind: PairKind) => submit({ ...cell, delay: 0 }, kind);
    const run = await measurePairedTimings(matrix(), skipsTheDelay, clock);
    expect(timingFailures(run)).toEqual([
      expect.stringMatching(
        /^control: fresh against fresh \+ 5 ms: EQUIVALENT, must be held slower/,
      ),
    ]);
  });

  it('a positive control that comes out different the wrong way round is no detection', async () => {
    const { instruments: clock, submit } = instruments(31, exponentialTail(10, 0.5));
    const backwards: Cell = {
      name: 'positive, held faster',
      expect: 'held slower',
      delay: -TIMING_MIN_DETECTABLE_MS,
    };
    const run = await measurePairedTimings([backwards], submit, clock);
    expect(run.outcomes[0]!.final).toMatchObject({ verdict: 'different', slowerKind: 'fresh' });
    expect(timingFailures(run)).toEqual([
      expect.stringMatching(/^positive, held faster: DIFFERENT, fresh slower, must be held slower/),
    ]);
  });

  it('a pair missing one of its submissions is refused, not recorded', async () => {
    const { instruments: clock, submit } = instruments(19, NOISES.quiet!);
    const dropsOne = {
      ...clock,
      shuffle: <T>(items: readonly T[]) => clock.shuffle(items).slice(0, 1),
    };
    await expect(measurePairedTimings(matrix(), submit, dropsOne)).rejects.toThrow(
      /a pair is one fresh and one held submission, not (fresh|held)$/,
    );
    const twiceHeld = {
      ...clock,
      shuffle: <T>(items: readonly T[]) => items.map(() => items.at(-1)!),
    };
    await expect(measurePairedTimings(matrix(), submit, twiceHeld)).rejects.toThrow(
      /a pair is one fresh and one held submission, not held, held$/,
    );
    await expect(measurePairedTimings([], submit, clock)).rejects.toThrow(RangeError);
  });

  it('a submission that fails fails the run: nothing is recorded for it', async () => {
    const { instruments: clock, submit } = instruments(23, NOISES.quiet!);
    let calls = 0;
    const flaky = async (cell: Cell, kind: PairKind) => {
      calls += 1;
      if (calls === 5) throw new Error('503');
      await submit(cell, kind);
    };
    await expect(measurePairedTimings(matrix(), flaky, clock)).rejects.toThrow('503');
  });
});
