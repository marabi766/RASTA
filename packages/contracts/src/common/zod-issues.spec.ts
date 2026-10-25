import { z } from 'zod';
import { LEGACY_PARSE, legacyIssues, type LegacyIssue } from './zod-issues';

/**
 * zod 4 issues read in zod 3's vocabulary. The goldens (recorded under zod 3)
 * pin the result through the pipe, the environment loader and the forms; these
 * pin each branch of the translation on its own.
 */
function legacy(schema: z.ZodType, input: unknown): LegacyIssue[] {
  const result = schema.safeParse(input, LEGACY_PARSE);
  if (result.success) throw new Error('expected a refusal');
  return legacyIssues(result.error.issues, schema);
}

const brief = (issues: LegacyIssue[]) =>
  issues.map(({ path, code, message }) => ({ path: path.join('.'), code, message }));

describe('legacyIssues', () => {
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

  it('without a schema, a one-value refusal reads as a literal’s and a longer one as an enum’s', () => {
    const literal = z.object({ l: z.literal('x') }).safeParse({ l: 'y' }, LEGACY_PARSE);
    const options = z.object({ e: z.enum(['A', 'B']) }).safeParse({ e: 'C' }, LEGACY_PARSE);
    expect(legacyIssues(literal.error?.issues ?? []).map((issue) => issue.code)).toEqual([
      'invalid_literal',
    ]);
    expect(legacyIssues(options.error?.issues ?? []).map((issue) => issue.code)).toEqual([
      'invalid_enum_value',
    ]);
  });

  it('without the value, a missing field is not guessed', () => {
    const result = z.object({ s: z.string() }).safeParse({});
    const [issue] = legacyIssues(result.error?.issues ?? [], z.object({ s: z.string() }));
    expect(issue).toMatchObject({ code: 'invalid_type', received: 'unknown' });
    // The value given instead stands in for the one the parse did not report.
    const [given] = legacyIssues(result.error?.issues ?? [], z.object({ s: z.string() }), {});
    expect(given).toMatchObject({
      code: 'invalid_type',
      received: 'undefined',
      message: 'Required',
    });
  });

  it('passes a code neither zod knows through as it is', () => {
    const forged = [
      { code: 'forged_code', path: ['a'], message: 'x' },
    ] as unknown as z.core.$ZodIssue[];
    expect(legacyIssues(forged).map((issue) => issue.code)).toEqual(['forged_code']);
  });
});
