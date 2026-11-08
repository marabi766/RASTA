/**
 * The disclosure guard, runner by runner: `not.toContain(sentinel)` and
 * `not.toMatch(sentinel)` over a string are refused when the string carries a
 * generated value (a ULID, UUID, instant or digest) the sentinel could occur
 * inside (`absenceHazard`), so an absence check cannot pass or fail by the
 * run's clock and ids (#452). Jest loads it through `disclosure-guard.ts`;
 * Playwright through `guardedAbsenceMatchers`, which `tests/e2e/src/expect.ts`
 * and `apps/web/e2e/expect.ts` install on the `expect` every spec imports.
 *
 * Imports nothing a browser-free Playwright worker lacks: no Jest, no
 * Playwright.
 */
import { absenceHazard } from './disclosure';

/**
 * Why the assertion is refused, or `undefined` when it may run: only a
 * negated `toContain` / `toMatch` of a string or regular expression over a
 * string is ever refused.
 */
export function absenceRefusal(
  isNot: boolean,
  received: unknown,
  expected: unknown,
): string | undefined {
  if (
    !isNot ||
    typeof received !== 'string' ||
    !(typeof expected === 'string' || expected instanceof RegExp)
  ) {
    return undefined;
  }
  const hazard = absenceHazard(received, expected);
  return hazard === undefined
    ? undefined
    : `This absence assertion can fail by chance: ${hazard}.\n` +
        'Use expectNotDisclosed from @rasta/testing, which declares the generated values ' +
        'before it looks, or a sentinel no generated value can hold (wholeNumber; #452).';
}

export interface AbsenceMatcherResult {
  pass: boolean;
  message: () => string;
}

type Assertion = Record<'toContain' | 'toMatch', (expected: unknown) => unknown> & {
  not: Record<'toContain' | 'toMatch', (expected: unknown) => unknown>;
};

/**
 * `toContain` and `toMatch` for `expect.extend` of a runner whose built-ins
 * cannot be reached from a matcher (Playwright): a refused assertion fails
 * with the reason; every other one is the runner's own, asked through
 * `runnerExpect` — the unextended `expect`.
 */
export function guardedAbsenceMatchers(
  runnerExpect: (actual: unknown) => unknown,
): Record<
  'toContain' | 'toMatch',
  (this: { isNot?: boolean }, received: unknown, expected: unknown) => AbsenceMatcherResult
> {
  const guarded = (name: 'toContain' | 'toMatch') =>
    function (
      this: { isNot?: boolean },
      received: unknown,
      expected: unknown,
    ): AbsenceMatcherResult {
      const isNot = this.isNot === true;
      const refusal = absenceRefusal(isNot, received, expected);
      // Under `.not`, `pass: true` is the failure.
      if (refusal !== undefined) return { pass: true, message: () => refusal };
      const assertion = runnerExpect(received) as Assertion;
      try {
        (isNot ? assertion.not : assertion)[name](expected);
        return { pass: !isNot, message: () => '' };
      } catch (error) {
        return { pass: isNot, message: () => (error as Error).message };
      }
    };
  return { toContain: guarded('toContain'), toMatch: guarded('toMatch') };
}
