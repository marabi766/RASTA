import { absenceRefusal, guardedAbsenceMatchers } from './absence-guard';

const LUCKY = JSON.stringify({ timestamp: '2026-10-25T01:39:13.000Z' });

/** A runner's own matchers, as plain as they come: they throw on failure. */
function runner(actual: unknown) {
  const contains = (expected: unknown): boolean =>
    expected instanceof RegExp
      ? expected.test(String(actual))
      : Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual).includes(String(expected));
  const check = (want: boolean) => (expected: unknown) => {
    if (contains(expected) !== want) throw new Error(`runner: ${String(expected)}`);
  };
  return {
    toContain: check(true),
    toMatch: check(true),
    not: { toContain: check(false), toMatch: check(false) },
  };
}

describe('absenceRefusal', () => {
  it('refuses only a negated string assertion a generated value could fail', () => {
    expect(absenceRefusal(true, LUCKY, '12.5')).toMatch(/inside the generated instant/);
    expect(absenceRefusal(false, LUCKY, '12.5')).toBeUndefined();
    expect(absenceRefusal(true, ['12.5'], '12.5')).toBeUndefined();
    expect(absenceRefusal(true, LUCKY, '482139.5')).toBeUndefined();
  });
});

describe('guardedAbsenceMatchers (the Playwright guard)', () => {
  const { toContain, toMatch } = guardedAbsenceMatchers(runner);
  const not = { isNot: true };
  const plain = { isNot: false };

  it('fails a hazardous absence assertion, with the reason, on a run where it would pass', () => {
    const refused = toContain.call(not, LUCKY, '12.5');
    // Under `.not`, `pass: true` is the failure.
    expect(refused.pass).toBe(true);
    expect(refused.message()).toMatch(/can fail by chance.*expectNotDisclosed/s);
    expect(toMatch.call(not, LUCKY, /12\.5/).pass).toBe(true);
  });

  it('answers every other assertion as the runner does, both ways', () => {
    expect(toContain.call(not, LUCKY, '482139.5').pass).toBe(false); // absent: passes
    expect(toContain.call(not, 'price 482139.5', '482139.5')).toMatchObject({ pass: true }); // fails
    expect(toContain.call(not, 'price 482139.5', '482139.5').message()).toMatch(/^runner:/);
    expect(toContain.call(plain, LUCKY, '13.000').pass).toBe(true);
    expect(toContain.call(plain, LUCKY, 'nothing').pass).toBe(false);
    expect(toMatch.call(plain, LUCKY, /T01:39/).pass).toBe(true);
    expect(toContain.call(not, ['01JABCDEFGHJKMNPQRSTVWXYZ0'], '12.5').pass).toBe(false);
  });
});
