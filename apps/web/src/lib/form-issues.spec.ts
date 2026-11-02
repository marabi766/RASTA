/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { z } from 'zod';
import { legacyParse, type LegacyIssue } from '@rasta/contracts';

import { firstIssuePerField, formIssueMessage, GENERIC_FIELD_MESSAGE } from './form-issues';
import { legacyFormResolver } from './form-resolver';

/**
 * The portal's one Persian boundary for local validation (`form-issues.ts`).
 * Three layers: the message function itself, a source guard that no parser can
 * read an issue's message another way, and a sweep that feeds hostile input to
 * every exported form schema and checks what a person would be shown.
 */

const LATIN_LETTER = /[A-Za-z]/;
const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** Hamza letters and U+0654: the project's text policy for added copy. */
const FORBIDDEN_SPELLING = /[\u0654\u0623\u0625\u0624\u0626]/u;

// Parsed as every form parser parses (legacyParse): zod 3's issue, with the value it was raised on.
const issueOf = (schema: z.ZodTypeAny, value: unknown): LegacyIssue => {
  const result = legacyParse(schema, value);
  if (result.success) throw new Error('expected a failed parse');
  return result.refusal.issues[0]!;
};

describe('formIssueMessage', () => {
  it.each([
    [
      'a string over its maximum',
      z.string().max(200),
      'x'.repeat(201),
      'حداکثر ۲۰۰ نویسه مجاز است',
    ],
    ['an empty string over a minimum of 1', z.string().min(1), '', 'این مقدار را وارد کنید'],
    ['a string under a longer minimum', z.string().min(3), 'ab', 'حداقل ۳ نویسه لازم است'],
    ['an array under its minimum', z.array(z.string()).min(2), [], 'دست‌کم ۲ مورد لازم است'],
    [
      'an array over its maximum',
      z.array(z.string()).max(2),
      ['a', 'b', 'c'],
      'حداکثر ۲ مورد مجاز است',
    ],
    ['a number under its minimum', z.number().min(1), 0, 'مقدار نباید کمتر از ۱ باشد'],
    ['a number over its maximum', z.number().max(9), 10, 'مقدار نباید بیشتر از ۹ باشد'],
    ['a non-integer', z.number().int(), Infinity, 'یک عدد صحیح و معتبر وارد کنید'],
    ['a missing value', z.string(), undefined, 'این مقدار را وارد کنید'],
    ['a string that is not a number', z.number(), 'abc', 'یک عدد صحیح و معتبر وارد کنید'],
    ['a regex mismatch', z.string().regex(/^\d+$/), 'abc', 'نویسه‌های واردشده مجاز نیست'],
    ['an enum miss', z.enum(['A', 'B']), 'C', 'یکی از گزینه‌های موجود را انتخاب کنید'],
  ])(
    'says %s in Persian, with the limit and never the input',
    (_label, schema, value, expected) => {
      const message = formIssueMessage(issueOf(schema, value));
      expect(message).toBe(expected);
      expect(message).not.toMatch(LATIN_LETTER);
      expect(message).not.toMatch(FORBIDDEN_SPELLING);
    },
  );

  it('shows a message the schema wrote in Persian as written', () => {
    expect(formIssueMessage(issueOf(z.string().min(1, 'نام سازمان را وارد کنید'), ''))).toBe(
      'نام سازمان را وارد کنید',
    );
  });

  it('replaces a message somebody wrote in English, and one that repeats the input', () => {
    expect(formIssueMessage(issueOf(z.string().min(5, 'Too short'), 'a'))).toBe(
      'حداقل ۵ نویسه لازم است',
    );
    const echo = formIssueMessage(
      issueOf(
        z.string().refine(() => false, 'Not allowed: typed-input-marker'),
        'typed-input-marker',
      ),
    );
    expect(echo).toBe(GENERIC_FIELD_MESSAGE);
    expect(echo).not.toContain('typed-input-marker');
  });

  it('answers one generic Persian sentence for an issue it cannot describe', () => {
    const unknown: LegacyIssue = {
      code: 'custom',
      path: ['x'],
      message: 'Something nobody foresaw',
      zodDefault: false,
    };
    expect(formIssueMessage(unknown)).toBe(GENERIC_FIELD_MESSAGE);
    expect(GENERIC_FIELD_MESSAGE).toMatch(ARABIC_LETTER);
    expect(GENERIC_FIELD_MESSAGE).not.toMatch(LATIN_LETTER);
    // An issue the translation drops (a key schema's wrapper with nothing inside).
    expect(formIssueMessage(undefined)).toBe(GENERIC_FIELD_MESSAGE);
  });

  it('serves a form resolver the same sentences, through legacyParse', async () => {
    const schema = z.object({ name: z.string().max(5), n: z.number().int() });
    const resolved = await legacyFormResolver(schema)({ name: 'abcdefg', n: 1.5 }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(resolved.errors).toEqual({
      name: { type: 'too_big', message: 'حداکثر ۵ نویسه مجاز است', ref: undefined },
      n: { type: 'invalid_type', message: 'یک عدد صحیح و معتبر وارد کنید', ref: undefined },
    });
  });

  it('lets stock zod decide a form resolver’s answer (D-078)', async () => {
    const options = { fields: {}, shouldUseNativeValidation: false } as const;
    // Codex PR-444 r3 F3: a refusal another combinator would reconcile away
    // in zod 3's order. Stock zod refuses it, and so does the form.
    const left = z
      .object({ a: z.string() })
      .strict()
      .transform((value) => value)
      .refine(() => false, 'never allowed');
    const refused = await legacyFormResolver(z.intersection(left, z.object({ b: z.string() })))(
      { a: 'a', b: 'b' },
      undefined,
      options,
    );
    expect(refused.values).toEqual({});
    expect(Object.keys(refused.errors)).toEqual(['']);
    // Accepted: the values are stock zod's output.
    const schema = z.object({ n: z.string().transform(Number), d: z.string().prefault('x') });
    const accepted = await legacyFormResolver(schema)({ n: '5' }, undefined, options);
    expect(accepted).toEqual({ values: schema.parse({ n: '5' }), errors: {} });
  });
});

describe('firstIssuePerField', () => {
  const schema = z.object({
    name: z.string().max(3),
    roles: z.array(z.string().min(1)),
    extra: z.string().max(1),
  });

  it('keeps the first issue per field, for the fields the form has, in Persian', () => {
    const result = legacyParse(schema, { name: 'abcd', roles: [''], extra: 'zz' });
    if (result.success) throw new Error('expected a failure');
    expect(firstIssuePerField(result.refusal, ['name', 'roles'])).toEqual({
      name: 'حداکثر ۳ نویسه مجاز است',
      roles: 'این مقدار را وارد کنید',
    });
  });

  it('accepts a type guard as well as a list, and drops what is not a field', () => {
    const result = legacyParse(schema, { name: 'abcd', roles: [''], extra: 'zz' });
    if (result.success) throw new Error('expected a failure');
    const only = (value: string): value is 'extra' => value === 'extra';
    expect(firstIssuePerField(result.refusal, only)).toEqual({
      extra: 'حداکثر ۱ نویسه مجاز است',
    });
  });
});

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'test' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.(spec|test)\.|fixture/.test(entry) ? [path] : [];
  });
}

describe('no parser reads Zod’s own message', () => {
  // Reading `.path` of an issue (to name a missing environment variable) never
  // shows a sentence; these two do exactly that and nothing else. The boundary
  // itself (form-issues.ts, and the form resolver, which reads a legacyParse
  // refusal's issues and words each through formIssueMessage) is the third.
  const PATH_ONLY = new Set([
    'lib/form-issues.ts',
    'lib/form-resolver.ts',
    'server/env.ts',
    'server/oidc.ts',
  ]);

  it('uses ZodError.issues only inside the boundary (or to read paths)', () => {
    const offenders = sources(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !PATH_ONLY.has(file))
      .filter((file) =>
        /\.issues\b|\.flatten\(|\.formErrors\b|\.format\(\)/.test(
          readFileSync(join(SRC, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('keeps the two path-only readers path-only', () => {
    for (const file of ['server/env.ts', 'server/oidc.ts']) {
      const lines = readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .filter((line) => /\.issues\b/.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toMatch(/\.message\b/);
    }
  });

  it('reaches firstIssuePerField only through legacyParse (r1 F1)', () => {
    // The function takes the refusal legacyParse returns and refuses anything
    // else at run time; this keeps the sources honest too: no parse of its own
    // with the issue values reported, no zod error handed to it.
    const offenders = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return /reportInput|LEGACY_PARSE|firstIssu\w*\(\s*\w+\.error\b/.test(text)
        ? [relative(SRC, file)]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  it('parses every form through legacyFormResolver (D-078, addendum E)', () => {
    // Stock zod decides and a refusal is worded once, by legacyParse: no
    // resolver of the library's own (zodResolver parsed with zod directly), no
    // hand-written one, no error map standing in for the translation.
    const offenders = sources(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => file !== 'lib/form-resolver.ts')
      .filter((file) => {
        const text = readFileSync(join(SRC, file), 'utf8');
        return (
          /@hookform\/resolvers/.test(text) ||
          /\bresolver\s*:(?!\s*legacyFormResolver\()/.test(text) ||
          /persianErrorMap|legacyIssueInErrorMap/.test(text)
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe('a refusal legacyParse took from stock zod (D-078, addendum H)', () => {
  const VALUE = 'SENTINEL-041-value';
  const options = { fields: {}, shouldUseNativeValidation: false } as const;
  const left = z
    .object({ a: z.string() })
    .strict()
    .transform((value) => value)
    .refine(() => false, 'never allowed');
  // Codex PR-444 r3 F3's shape: in zod 3's order the key issue is reconciled away.
  const fallback = z.intersection(left, z.object({ b: z.string() }));
  const ordinary = z.object({ a: z.string(), b: z.string() }).refine(() => false, 'never allowed');
  const generic = z.object({
    a: z.string().refine(() => false, {
      error: () => {
        throw new Error(VALUE);
      },
    }),
  });
  const input = { a: VALUE, b: VALUE };

  it('shows it in a form as the same refusal reached the ordinary way, no value in it', async () => {
    expect(
      fallback.safeParse(input, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never)
        .success,
    ).toBe(true);
    const a = await legacyFormResolver(fallback)(input, undefined, options);
    const b = await legacyFormResolver(ordinary)(input, undefined, options);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain(VALUE);
    const refused = legacyParse(fallback, input);
    const same = legacyParse(ordinary, input);
    if (refused.success || same.success) throw new Error('expected refusals');
    expect(firstIssuePerField(refused.refusal, ['a', 'b'])).toEqual(
      firstIssuePerField(same.refusal, ['a', 'b']),
    );
  });

  it('shows the generic refusal as one generic Persian sentence', async () => {
    const resolved = await legacyFormResolver(generic)({ a: VALUE }, undefined, options);
    expect(resolved.errors).toEqual({
      '': { type: 'custom', message: GENERIC_FIELD_MESSAGE, ref: undefined },
    });
    expect(JSON.stringify(resolved)).not.toContain(VALUE);
  });
});
