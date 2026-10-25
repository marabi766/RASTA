import { inspect } from 'node:util';
import { z } from 'zod';
import { currencySchema } from './money';
import {
  LegacyContextError,
  LegacyRefusal,
  describeLegacyRefusal,
  isLegacyRefusal,
  legacyIssueInErrorMap,
  legacyParse,
  requireLegacyRefusal,
  type LegacyIssue,
} from './zod-issues';

/**
 * zod 4 issues read in zod 3's vocabulary. The goldens (recorded under zod 3)
 * pin the result through the pipe, the environment loader and the forms; these
 * pin each branch of the translation on its own.
 */
function legacy(schema: z.ZodType, input: unknown): LegacyIssue[] {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return [...result.refusal.issues];
}

const brief = (issues: LegacyIssue[]) =>
  issues.map(({ path, code, message }) => ({ path: path.join('.'), code, message }));

describe('legacyParse', () => {
  it('renames codes and rewrites default messages as zod 3 wrote them', () => {
    const schema = z
      .object({
        s: z.string(),
        n: z.number().int(),
        e: z.enum(['A', 'B']),
        l: z.literal('yes'),
        f: z.string().regex(/^\d+$/),
        m: z.number().multipleOf(5),
        b: z.string().min(3),
      })
      .strict();
    expect(
      brief(legacy(schema, { n: 1.5, e: 'C', l: 'no', f: 'x', m: 7, b: 'ab', extra: 1 })),
    ).toEqual([
      { path: 's', code: 'invalid_type', message: 'Required' },
      { path: 'n', code: 'invalid_type', message: 'Expected integer, received float' },
      {
        path: 'e',
        code: 'invalid_enum_value',
        message: "Invalid enum value. Expected 'A' | 'B', received 'C'",
      },
      { path: 'l', code: 'invalid_literal', message: 'Invalid literal value, expected "yes"' },
      { path: 'f', code: 'invalid_string', message: 'Invalid' },
      { path: 'm', code: 'not_multiple_of', message: 'Number must be a multiple of 5' },
      { path: 'b', code: 'too_small', message: 'String must contain at least 3 character(s)' },
      { path: '', code: 'unrecognized_keys', message: "Unrecognized key(s) in object: 'extra'" },
    ]);
  });

  it('keeps a message the schema wrote, and says which messages were zod’s', () => {
    const [own, zods] = legacy(
      z.object({ a: z.string({ error: 'متن لازم است' }), b: z.string() }).strict(),
      { a: 1, b: 2 },
    );
    expect(own).toMatchObject({ code: 'invalid_type', message: 'متن لازم است', zodDefault: false });
    expect(zods).toMatchObject({ message: 'Expected string, received number', zodDefault: true });
  });

  it('an enum given another type is invalid_type, as zod 3 checked the type first', () => {
    expect(brief(legacy(z.object({ e: z.enum(['A', 'B']) }), { e: 7 }))).toEqual([
      { path: 'e', code: 'invalid_type', message: "Expected 'A' | 'B', received number" },
    ]);
  });

  it('a union of two check-only failures reports the first option, as zod 3 did', () => {
    const id = z.union([
      z.string().refine((value) => value.startsWith('ORG_'), 'Expected ORG_<ULID>'),
      z.string().regex(/^ORG-[A-Z]+$/),
    ]);
    expect(brief(legacy(z.object({ id }), { id: 'nope' }))).toEqual([
      { path: 'id', code: 'custom', message: 'Expected ORG_<ULID>' },
    ]);
  });

  it('a union where every option fails on its type stays invalid_union', () => {
    expect(brief(legacy(z.union([z.string(), z.number()]), true))).toEqual([
      { path: '', code: 'invalid_union', message: 'Invalid input' },
    ]);
  });

  it('a union whose one check-only option is over its cap reports that option', () => {
    const schema = z.union([
      z.object({ a: z.string() }).strict(),
      z.object({ any: z.array(z.string()).max(2) }).strict(),
    ]);
    expect(brief(legacy(schema, { any: ['x', 'y', 'z'] }))).toEqual([
      { path: 'any', code: 'too_big', message: 'Array must contain at most 2 element(s)' },
    ]);
  });

  it('a discriminator miss is invalid_union_discriminator with the declared options', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A') }),
      z.object({ kind: z.literal('B') }),
    ]);
    expect(brief(legacy(schema, { kind: 'C' }))).toEqual([
      {
        path: 'kind',
        code: 'invalid_union_discriminator',
        message: "Invalid discriminator value. Expected 'A' | 'B'",
      },
    ]);
  });

  it('±Infinity replays the number’s own checks, with their messages, as zod 3 ran them', () => {
    const schema = z.object({ q: z.number().min(1).max(5, 'at most five').int() });
    expect(brief(legacy(schema, { q: Number.POSITIVE_INFINITY }))).toEqual([
      { path: 'q', code: 'too_big', message: 'at most five' },
      { path: 'q', code: 'invalid_type', message: 'Expected integer, received float' },
    ]);
    // A number with no check refused it only through `.finite()`.
    expect(brief(legacy(z.object({ q: z.number() }), { q: Number.NEGATIVE_INFINITY }))).toEqual([
      { path: 'q', code: 'not_finite', message: 'Number must be finite' },
    ]);
  });

  it('a record key refused by its key schema is reported as that schema’s issue', () => {
    const schema = z.record(z.string().regex(/^[a-z]+$/), z.number());
    expect(brief(legacy(schema, { ABC: 1 }))).toEqual([
      { path: 'ABC', code: 'invalid_string', message: 'Invalid' },
    ]);
  });

  it('a one-value enum is an enum and a literal a literal: the schema decides, not the count (r1 F1)', () => {
    // currencySchema is z.enum(['IRR']): one value, still an enum, as zod 3 reported it.
    const schema = z.object({ currency: currencySchema, kind: z.literal('X') });
    expect(brief(legacy(schema, { currency: 'USD', kind: 'Y' }))).toEqual([
      {
        path: 'currency',
        code: 'invalid_enum_value',
        message: "Invalid enum value. Expected 'IRR', received 'USD'",
      },
      { path: 'kind', code: 'invalid_literal', message: 'Invalid literal value, expected "X"' },
    ]);
  });

  it('a missing enum field is Required, and an enum given a number is a type refusal (r1 F1)', () => {
    // CONTRACT_AUTHORITY_REFUSED with payload {} and an envelope with actor.type 7, as zod 3 read them.
    const schema = z.object({
      side: z.enum(['A', 'B']),
      actor: z.object({ type: z.enum(['USER']) }),
    });
    expect(brief(legacy(schema, { actor: { type: 7 } }))).toEqual([
      { path: 'side', code: 'invalid_type', message: 'Required' },
      { path: 'actor.type', code: 'invalid_type', message: "Expected 'USER', received number" },
    ]);
  });

  it('a non-finite number after a preprocess replays the checks on the parsed number (r1 F1, ?limit=1e999)', () => {
    const limit = z.preprocess(
      (value) => (typeof value === 'string' ? Number(value) : value),
      z.number().int().min(1).max(200),
    );
    expect(brief(legacy(z.object({ limit }), { limit: '1e999' }))).toEqual([
      { path: 'limit', code: 'invalid_type', message: 'Expected integer, received float' },
      { path: 'limit', code: 'too_big', message: 'Number must be less than or equal to 200' },
    ]);
  });

  it('after an .int() refusal, runs the later checks as zod 3 did (zod 4 stops there)', () => {
    const schema = z.object({
      q: z.number().multipleOf(5).int().min(10).max(20, 'at most twenty'),
    });
    expect(brief(legacy(schema, { q: 7.5 }))).toEqual([
      { path: 'q', code: 'not_multiple_of', message: 'Number must be a multiple of 5' },
      { path: 'q', code: 'invalid_type', message: 'Expected integer, received float' },
      { path: 'q', code: 'too_small', message: 'Number must be greater than or equal to 10' },
    ]);
    expect(brief(legacy(schema, { q: 25.5 }))).toEqual([
      { path: 'q', code: 'not_multiple_of', message: 'Number must be a multiple of 5' },
      { path: 'q', code: 'invalid_type', message: 'Expected integer, received float' },
      { path: 'q', code: 'too_big', message: 'at most twenty' },
    ]);
  });

  it('passes a code neither zod knows through as it is', () => {
    const schema = z.object({ a: z.string() }).superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'forged_code', path: ['a'], message: 'x' } as never);
    });
    expect(legacy(schema, { a: 'ok' }).map((issue) => issue.code)).toEqual(['forged_code']);
  });

  it('accepts exactly what safeParse accepts, with the same output', () => {
    const schema = z.object({ n: z.coerce.number().prefault(3), s: z.string().trim() });
    expect(legacyParse(schema, { s: ' x ' })).toEqual({ success: true, data: { n: 3, s: 'x' } });
    expect(legacyParse(schema, { s: 1 }).success).toBe(schema.safeParse({ s: 1 }).success);
  });
});

describe('early rejection survives the translation (PM addendum B)', () => {
  it('an over-cap array: one too_big, no element parsed, no refinement over the elements run', () => {
    const element = z.string().min(3);
    const elementRun = jest.spyOn(element._zod, 'run');
    const refinement = jest.fn(() => true);
    const schema = z.object({ items: z.array(element).max(2).refine(refinement, 'each once') });
    const refused = legacyParse(schema, { items: ['a', 'b', 'c', 'd', 'e'] });
    expect(refused.success).toBe(false);
    expect(brief([...(refused.refusal?.issues ?? [])])).toEqual([
      { path: 'items', code: 'too_big', message: 'Array must contain at most 2 element(s)' },
    ]);
    expect(elementRun).not.toHaveBeenCalled();
    expect(refinement).not.toHaveBeenCalled();
  });
});

describe('the refusal is the only way to a translation (r1 F1 guard)', () => {
  const SENTINEL = 'SENTINEL-109-value';
  const schema = z.object({ e: z.enum(['A', 'B']), s: z.string().max(3) }).strict();

  it('every formatter refuses a bare zod error, its issues, or a hand-built look-alike', () => {
    const bare = schema.safeParse({ e: SENTINEL }).error;
    for (const notARefusal of [bare, bare?.issues, { issues: [] }, undefined, null]) {
      expect(isLegacyRefusal(notARefusal)).toBe(false);
      expect(() => requireLegacyRefusal(notARefusal, 'formatter')).toThrow(LegacyContextError);
    }
    expect(
      () =>
        new (LegacyRefusal as unknown as new (...args: unknown[]) => unknown)(
          Symbol(),
          [],
          schema,
          {},
        ),
    ).toThrow(LegacyContextError);
    const refused = legacyParse(schema, { e: 'C' }).refusal;
    expect(requireLegacyRefusal(refused, 'formatter')).toBe(refused);
  });

  it('the refusal shows paths and codes only: never the input or zod 4’s error (PM addendum C)', () => {
    const input = { e: 'A', s: SENTINEL, [SENTINEL]: 1 };
    const refusal = legacyParse(schema, input).refusal as LegacyRefusal;
    expect(Object.keys(refusal)).toEqual(['issues']);
    expect(refusal.input).toBe(input);
    expect(refusal.schema).toBe(schema);
    for (const shown of [
      JSON.stringify(refusal),
      inspect(refusal, { depth: 10 }),
      String(refusal),
    ]) {
      expect(shown).not.toContain(SENTINEL);
    }
    const error = new LegacyContextError('formatter');
    expect(`${error.message}${error.stack ?? ''}`).not.toContain(SENTINEL);
  });
});

describe('legacyIssueInErrorMap', () => {
  it('reads the raised-by schema and the value off the raw issue', () => {
    const issues: (LegacyIssue | undefined)[] = [];
    const error = (issue: z.core.$ZodRawIssue) => {
      issues.push(legacyIssueInErrorMap(issue));
      return undefined;
    };
    const result = z
      .object({ c: currencySchema, n: z.number().max(5) })
      .safeParse({ c: 'USD', n: Number.POSITIVE_INFINITY }, { error });
    // zod 4.6.7 finishes the issues, running the maps, when the error is first read.
    expect(result.error?.issues).toHaveLength(2);
    expect(issues.map((issue) => issue?.code)).toEqual(['invalid_enum_value', 'too_big']);
  });
});

describe('describeLegacyRefusal', () => {
  const SENTINEL = 'SENTINEL-109-describe';
  const schema = z
    .object({ kind: z.enum(['A', 'B']), n: z.number().int(), list: z.array(z.string()) })
    .superRefine((_value, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['n'], message: 'n is fixed by the event' });
    });

  it('names paths and zod 3 codes, keeps the schema’s own sentence, and never a value', () => {
    const refused = legacyParse(schema, { kind: SENTINEL, n: 1, list: [] })
      .refusal as LegacyRefusal;
    const line = describeLegacyRefusal(refused);
    expect(line).toBe('kind invalid_enum_value');
    expect(line).not.toContain(SENTINEL);
    const custom = legacyParse(schema, { kind: 'A', n: 1, list: [] }).refusal as LegacyRefusal;
    expect(describeLegacyRefusal(custom)).toBe('n custom (n is fixed by the event)');
  });

  it('names at most `limit` issues and counts the rest', () => {
    const many = z.object(
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, z.string()])),
    );
    expect(describeLegacyRefusal(legacyParse(many, {}).refusal as LegacyRefusal, 2)).toBe(
      'f0 invalid_type, f1 invalid_type, …(12 total)',
    );
  });
});
