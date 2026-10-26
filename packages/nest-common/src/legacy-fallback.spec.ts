import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { invalidPayloadError } from './consumer/invalid-payload';
import { unparseableReason } from './consumer/event-consumer';
import { RastaError } from './errors/rasta-error';
import { toErrorDetails, validateRequestInput } from './pipes/zod-validation.pipe';

/**
 * D-078, PR #444 r4 addendum H. When the zod 3-ordered pass cannot word a
 * refusal (it accepted — Codex PR-444 r3 F3 — threw, or said nothing),
 * legacyParse keeps stock zod's refusal, and when even that cannot be worded,
 * one fixed generic issue. Every formatter here reports such a refusal
 * exactly as it reports the same refusal reached the ordinary way, and none
 * repeats a value or a raw zod error.
 */

const VALUE = 'SENTINEL-041-value';
const RECORD_NAME = 'SENTINEL-041-record';

function refused(schema: z.ZodType, input: unknown): LegacyRefusal {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
}

/** The stock-zod fallback (r3 F3's shape under a record), the same refusal reached the ordinary way, and the generic one. */
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
  const input = { tags: { [RECORD_NAME]: { a: VALUE, b: VALUE } } };
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

const text = (value: unknown): string => JSON.stringify(value) ?? String(value);

describe('formatters of a stock-zod fallback refusal (D-078, addendum H)', () => {
  const { fallback, ordinary, generic } = refusals();

  it('HTTP: the pipe details it as the ordinary refusal, the key masked and no value', () => {
    expect(toErrorDetails(fallback)).toEqual(toErrorDetails(ordinary));
    expect(text(toErrorDetails(fallback))).not.toMatch(/SENTINEL-041/);
    expect(toErrorDetails(generic)).toEqual([
      { path: '(root)', code: 'custom', message: expect.any(String) },
    ]);
    expect(text(toErrorDetails(generic))).not.toContain(VALUE);
    let thrown: unknown;
    try {
      validateRequestInput(
        z.object({
          a: z.string().refine(() => false, {
            error: () => {
              throw new Error(VALUE);
            },
          }),
        }),
        { a: VALUE },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RastaError);
    expect(text(thrown) + String((thrown as Error).message)).not.toContain(VALUE);
  });

  it('dead letter: invalidPayloadError names it as the ordinary refusal', () => {
    const envelope = { eventName: 'test.event', eventId: 'EVT-041' };
    const a = invalidPayloadError(envelope, fallback, ['tags']);
    const b = invalidPayloadError(envelope, ordinary, ['tags']);
    expect(a.message).toBe(b.message);
    expect(a.message).not.toMatch(/SENTINEL-041/);
    expect(invalidPayloadError(envelope, generic, ['a']).message).not.toContain(VALUE);
  });

  it('dead letter: unparseableReason names it as the ordinary refusal', () => {
    const body = Buffer.from('{}');
    // Envelope paths are schema fields, printed as today; the values never are.
    expect(unparseableReason(fallback, body)).toBe(unparseableReason(ordinary, body));
    expect(unparseableReason(fallback, body)).not.toContain(VALUE);
    expect(unparseableReason(generic, body)).toBe(
      'the body is not a valid event envelope (2 bytes): "(root)" custom',
    );
    expect(unparseableReason(generic, body)).not.toContain(VALUE);
  });
});
