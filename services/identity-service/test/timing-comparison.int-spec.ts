import { compareTimings, median, requiredAgreeing, TIMING_FLOOR_MS } from './timing-comparison';

/**
 * The rule that registration-acknowledgement.int-spec.ts judges the clock by
 * (task 302), on its own: no database, no service, a seeded generator. What it
 * has to be: never wrong on equal work whatever the noise, and not blind to a
 * delay that decides by identity.
 */

/** mulberry32: a small seeded generator, so the trials are the same on every run. */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Noise = (random: () => number) => number;
const NOISES: Record<string, Noise> = {
  // A quiet machine: 6 ms and a millisecond or so.
  quiet: (random) => 6 + (random() + random() + random() - 1.5),
  // A loaded runner: half the requests are caught by a pause of 15–25 ms — the
  // shape on which two medians flip between the modes (the CI failures).
  'bimodal, half caught by a pause': (random) =>
    6 + random() * 2 + (random() < 0.5 ? 15 + random() * 10 : 0),
  // Rare, long stalls.
  'heavy tail': (random) => 6 + random() + (random() < 0.1 ? -Math.log(random() + 1e-9) * 30 : 0),
};

/** One round of the measurement: `pairs` pairs, order random, `delay` added to every held answer. */
const differences = (noise: Noise, random: () => number, pairs: number, delay: number) =>
  Array.from({ length: pairs }, () => {
    const first = noise(random);
    const second = noise(random);
    // Which of the two was the held one is the coin the rule is built on.
    return random() < 0.5 ? second + delay - first : first + delay - second;
  });

/** The rule this replaces: medians of 30 held and 30 fresh within max(5 ms, 25 % of fresh). */
const previousRuleFails = (noise: Noise, random: () => number) => {
  const fresh = Array.from({ length: 30 }, () => noise(random));
  const held = Array.from({ length: 30 }, () => noise(random));
  const base = median(fresh);
  return Math.abs(median(held) - base) >= Math.max(5, 0.25 * base);
};

describe('the rule for "does one kind of request take longer than the other" (task 302)', () => {
  it('asks for more agreeing pairs than a fair coin gives, per the exact binomial tail', () => {
    // Worked by hand from C(n, k) / 2^n: one side's tail at the required count
    // is ≤ 5e-7, and one count lower it is not.
    const tail = (n: number, from: number) => {
      let term = Math.pow(0.5, n);
      let sum = from === 0 ? term : 0;
      for (let k = 0; k < n; k += 1) {
        term = (term * (n - k)) / (k + 1);
        if (k + 1 >= from) sum += term;
      }
      return sum;
    };
    for (const n of [10, 30, 60, 100, 150]) {
      const required = requiredAgreeing(n);
      expect(tail(n, required)).toBeLessThanOrEqual(5e-7);
      expect(tail(n, required - 1)).toBeGreaterThan(5e-7);
    }
    expect([30, 60, 100, 150].map((n) => requiredAgreeing(n))).toEqual([28, 49, 75, 106]);
    // Too few pairs to ever be sure: even all agreeing is not enough.
    expect(requiredAgreeing(10)).toBe(11);
    expect(compareTimings(Array(10).fill(50)).differs).toBe(false);
    expect(() => requiredAgreeing(0)).toThrow(RangeError);
    expect(() => requiredAgreeing(10, 0)).toThrow(RangeError);
  });

  it('needs both: nearly every pair on one side AND a difference worth the name', () => {
    const pairs = 100;
    const required = requiredAgreeing(pairs);
    // Every pair a hair slower: certain, and not a difference of any size.
    expect(compareTimings(Array(pairs).fill(TIMING_FLOOR_MS / 4))).toMatchObject({
      slower: pairs,
      differs: false,
    });
    // At the floor, all on one side, in either direction.
    expect(compareTimings(Array(pairs).fill(TIMING_FLOOR_MS)).differs).toBe(true);
    expect(compareTimings(Array(pairs).fill(-TIMING_FLOOR_MS)).differs).toBe(true);
    // One pair short of the count: a coin could do that.
    const short = [...Array(required - 1).fill(10), ...Array(pairs - required + 1).fill(-0.1)];
    expect(compareTimings(short)).toMatchObject({ slower: required - 1, differs: false });
    const enough = [...Array(required).fill(10), ...Array(pairs - required).fill(-0.1)];
    expect(compareTimings(enough)).toMatchObject({ slower: required, differs: true });
    // Ties are no side.
    expect(compareTimings(Array(pairs).fill(0))).toMatchObject({
      slower: 0,
      faster: 0,
      differs: false,
    });
  });

  it.each(Object.keys(NOISES))(
    'is never wrong on equal work, whatever the noise — %s: 4000 cells of 100 pairs, none condemned',
    (name) => {
      const random = generator(302);
      let condemned = 0;
      for (let cell = 0; cell < 4000; cell += 1) {
        if (compareTimings(differences(NOISES[name]!, random, 100, 0)).differs) condemned += 1;
      }
      expect(condemned).toBe(0);
    },
  );

  it('whereas the medians it replaces were wrong on equal work when half the requests meet a pause', () => {
    const random = generator(302);
    let wrong = 0;
    for (let cell = 0; cell < 1000; cell += 1) {
      if (previousRuleFails(NOISES['bimodal, half caught by a pause']!, random)) wrong += 1;
    }
    // Hundreds of cells in a thousand: this is the bug being fixed, not a margin.
    expect(wrong).toBeGreaterThan(200);
  });

  it('sees a delay on every answer of one kind: 5 ms on a quiet machine, 12 ms through rare stalls, 30 ms through a pause on half the requests', () => {
    for (const [name, delay] of [
      ['quiet', 5],
      ['quiet', -5],
      ['bimodal, half caught by a pause', 30],
      ['bimodal, half caught by a pause', -30],
      ['heavy tail', 12],
    ] as const) {
      const random = generator(1302);
      let seen = 0;
      for (let cell = 0; cell < 500; cell += 1) {
        if (compareTimings(differences(NOISES[name]!, random, 100, delay)).differs) seen += 1;
      }
      expect({ name, delay, seen }).toEqual({ name, delay, seen: 500 });
    }
  });
});
