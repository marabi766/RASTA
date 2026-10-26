import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { describeIssues } from './audit-trail-envelope';

/**
 * D-078, PR #444 r4 addendum H: the audit-trail envelope's self-check reports
 * a refusal legacyParse took from stock zod exactly as the same refusal
 * reached the ordinary way, and the fixed generic one without a value.
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

describe('describeIssues on a stock-zod fallback refusal (D-078, addendum H)', () => {
  it('reports it as the ordinary refusal, and the generic one, without a value', () => {
    const { fallback, ordinary, generic } = refusals();
    expect(describeIssues(fallback)).toBe(describeIssues(ordinary));
    expect(describeIssues(fallback)).not.toContain(VALUE);
    expect(describeIssues(generic)).toBe('(root) custom');
  });
});
