/**
 * Jest setup (`setupFilesAfterEnv`) loaded by every Jest configuration in the
 * repository — `scripts/disclosure-guard-wiring.test.mjs` holds each one to it.
 *
 * `not.toContain(sentinel)` and `not.toMatch(sentinel)` over a string are
 * refused when the string carries a generated value (a ULID, UUID, instant or
 * digest) the sentinel could occur inside (`absenceHazard`): such an assertion
 * passes or fails by the run's clock and ids, not by what was disclosed (#452:
 * `"12.5"` inside `…:12.584Z`, `/403/` inside a correlation ULID). It is
 * refused on every run, not only the unlucky one, so the hazard is found when
 * the test is written. The way through is `expectNotDisclosed`, which declares
 * the generated values before it looks — or a sentinel no generated value can
 * hold.
 *
 * Everything else — arrays, a sentinel with no hazard, the positive forms —
 * reaches Jest's own matcher unchanged.
 */
import { absenceRefusal } from './absence-guard';

type BuiltIn = (
  this: jest.MatcherContext,
  received: unknown,
  expected: unknown,
) => jest.CustomMatcherResult;

/** Where `expect` keeps its matchers, the built-ins included (the `expect` package, Jest 29). */
const registry = (
  globalThis as unknown as Record<symbol, { matchers?: Record<string, BuiltIn> } | undefined>
)[Symbol.for('$$jest-matchers-object')];
const builtIn = { toContain: registry?.matchers?.toContain, toMatch: registry?.matchers?.toMatch };

function guarded(name: 'toContain' | 'toMatch'): BuiltIn {
  const original = builtIn[name];
  // Fail closed: without the built-in there is nothing to delegate to.
  if (original === undefined) {
    throw new Error(`disclosure guard: Jest's built-in ${name} was not found`);
  }
  return function (this: jest.MatcherContext, received: unknown, expected: unknown) {
    const refusal = absenceRefusal(this.isNot === true, received, expected);
    if (refusal !== undefined) {
      return {
        // Under `.not`, `pass: true` is the failure.
        pass: true,
        message: () =>
          `${this.utils.matcherHint(name, undefined, undefined, { isNot: true })}\n\n${refusal}`,
      };
    }
    return original.call(this, received, expected);
  };
}

expect.extend({ toContain: guarded('toContain'), toMatch: guarded('toMatch') });
