import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { issuesOf as commissionIssues } from './commission-rule-change-projection';
import { unprocessable } from './contract-refusal-projection';
import { describeIssues as opsReplayIssues } from './ops-replay.mapper';
import { describeIssues as reconciliationIssues } from './payment-reconciliation-projection';
import { describeIssues as diagnosticIssues } from './refusal-diagnostics';
import { issuesOf as settlementIssues } from './settlement-refusal-projection';

/**
 * D-078, PR #444 r4 addendum H: every audit formatter of a refusal reports
 * one legacyParse took from stock zod exactly as the same refusal reached the
 * ordinary way, and the fixed generic refusal without a value or a raw error.
 */

const VALUE = 'SENTINEL-041-value';
const KEY = 'SENTINEL-041-key';

function refused(schema: z.ZodType, input: unknown): LegacyRefusal {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
}

/**
 * A refusal legacyParse took from stock zod (Codex PR-444 r3 F3's shape under
 * a record: run in zod 3's order the intersection reconciles the key issue
 * away), the same refusal reached the ordinary way, and the fixed generic one
 * (an error map that throws: neither pass can be worded).
 */
function refusals(): { fallback: LegacyRefusal; ordinary: LegacyRefusal; generic: LegacyRefusal } {
  const left = z
    .object({ a: z.string() })
    .strict()
    .transform((value) => value)
    .refine(() => false, 'never allowed');
  const fallback = z.object({
    tags: z.record(z.string(), z.intersection(left, z.object({ b: z.string() }))),
  });
  const ordinary = z.object({
    tags: z.record(
      z.string(),
      z.object({ a: z.string(), b: z.string() }).refine(() => false, 'never allowed'),
    ),
  });
  const input = { tags: { [KEY]: { a: VALUE, b: VALUE } } };
  expect(
    fallback.safeParse(input, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never).success,
  ).toBe(true);
  const generic = z.object({
    a: z.string().refine(() => false, {
      error: () => {
        throw new Error(VALUE);
      },
    }),
  });
  return {
    fallback: refused(fallback, input),
    ordinary: refused(ordinary, input),
    generic: refused(generic, { a: VALUE }),
  };
}

describe('audit formatters of a stock-zod fallback refusal (D-078, addendum H)', () => {
  const { fallback, ordinary, generic } = refusals();
  const formatters: [string, (refusal: LegacyRefusal) => string][] = [
    ['refusal diagnostics', (refusal) => diagnosticIssues(refusal, new Set(['tags', 'a', 'b']))],
    ['payment reconciliation', reconciliationIssues],
    ['ops replay', opsReplayIssues],
    ['settlement refusal', settlementIssues],
    ['commission rule change', commissionIssues],
    ['contract refusal', (refusal) => unprocessable('TEST_EVENT', refusal).message],
  ];

  it.each(formatters)(
    '%s: as the ordinary refusal, no value; generic, no value',
    (_name, format) => {
      expect(format(fallback)).toBe(format(ordinary));
      expect(format(fallback)).not.toContain(VALUE);
      // The root as each formatter names it today.
      expect(format(generic)).toMatch(/\((root|payload)\)/);
      expect(format(generic)).toMatch(/custom/);
      expect(format(generic)).not.toContain(VALUE);
    },
  );

  it('withholds the payload’s own key as today', () => {
    expect(diagnosticIssues(fallback, new Set(['tags']))).not.toContain(KEY);
    expect(reconciliationIssues(fallback)).not.toContain(KEY);
  });
});
