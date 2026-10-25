/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { displayText } from '@rasta/contracts';
import { z } from 'zod';

import {
  firstIssuePerField,
  formIssueMessage,
  GENERIC_FIELD_MESSAGE,
  persianErrorMap,
  persianResolver,
} from './form-issues';

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

const issueOf = (schema: z.ZodTypeAny, value: unknown): z.ZodIssue => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected a failed parse');
  return result.error.issues[0]!;
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
    const unknown: z.ZodIssue = {
      code: 'custom',
      path: ['x'],
      message: 'Something nobody foresaw',
    };
    expect(formIssueMessage(unknown)).toBe(GENERIC_FIELD_MESSAGE);
    expect(GENERIC_FIELD_MESSAGE).toMatch(ARABIC_LETTER);
    expect(GENERIC_FIELD_MESSAGE).not.toMatch(LATIN_LETTER);
    const odd = {
      code: 'invalid_arguments',
      path: [],
      message: 'Invalid arguments',
      argumentsError: new z.ZodError([]),
    } as unknown as z.ZodIssue;
    expect(formIssueMessage(odd)).toBe(GENERIC_FIELD_MESSAGE);
  });

  it('serves a resolver the same sentences through the error map', () => {
    const schema = z.object({ name: z.string().max(5), n: z.number().int() });
    const result = schema.safeParse({ name: 'abcdefg', n: 1.5 }, { errorMap: persianErrorMap });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(['حداکثر ۵ نویسه مجاز است', 'یک عدد صحیح و معتبر وارد کنید']);
  });
});

describe('firstIssuePerField', () => {
  const schema = z.object({
    name: z.string().max(3),
    roles: z.array(z.string().min(1)),
    extra: z.string().max(1),
  });

  it('keeps the first issue per field, for the fields the form has, in Persian', () => {
    const result = schema.safeParse({ name: 'abcd', roles: [''], extra: 'zz' });
    if (result.success) throw new Error('expected a failure');
    expect(firstIssuePerField(result.error, ['name', 'roles'])).toEqual({
      name: 'حداکثر ۳ نویسه مجاز است',
      roles: 'این مقدار را وارد کنید',
    });
  });

  it('accepts a type guard as well as a list, and drops what is not a field', () => {
    const result = schema.safeParse({ name: 'abcd', roles: [''], extra: 'zz' });
    if (result.success) throw new Error('expected a failure');
    const only = (value: string): value is 'extra' => value === 'extra';
    expect(firstIssuePerField(result.error, only)).toEqual({ extra: 'حداکثر ۱ نویسه مجاز است' });
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
  // shows a sentence; these two do exactly that and nothing else.
  const PATH_ONLY = new Set(['lib/form-issues.ts', 'server/env.ts', 'server/oidc.ts']);

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

  it('builds every form resolver through persianResolver, never zodResolver', () => {
    const offenders = sources(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec.tsx'))
      .filter((file) => /zodResolver\b/.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('provenance, not language', () => {
  const REFLECTED = 'ناشناخته';
  const reflecting: ReadonlyArray<[string, z.ZodTypeAny]> = [
    ['an enum', z.enum(['A', 'B'])],
    ['a literal', z.literal('A')],
    ['a union', z.union([z.literal('A'), z.literal('B')])],
    ['a discriminated union', z.discriminatedUnion('k', [z.object({ k: z.literal('A') })])],
    ['a native enum', z.nativeEnum({ A: 'A' } as const)],
  ];
  const value = (label: string) => (label.includes('discriminated') ? { k: REFLECTED } : REFLECTED);

  it.each(reflecting)('never repeats Persian input a Zod default echoes (%s)', (label, schema) => {
    const issue = issueOf(schema, value(label));
    const message = formIssueMessage(issue);
    expect(message).not.toContain(REFLECTED);
    expect(message).not.toMatch(LATIN_LETTER);
    expect(message).toBe(
      label === 'a union' ? GENERIC_FIELD_MESSAGE : 'یکی از گزینه‌های موجود را انتخاب کنید',
    );
  });

  it('proves the reflected default really carries the input (the old escape)', () => {
    expect(issueOf(z.enum(['A', 'B']), REFLECTED).message).toContain(REFLECTED);
  });

  it('translates an English message a schema author wrote, even a contract one', () => {
    const issue = issueOf(displayText(1, 20), 'x<y');
    expect(issue.message).toBe('Contains unsupported characters');
    expect(formIssueMessage(issue)).toBe('نویسه‌های واردشده مجاز نیست');
    expect(formIssueMessage(issueOf(z.string().regex(/^a$/, 'Only letter a'), 'b'))).toBe(
      'نویسه‌های واردشده مجاز نیست',
    );
    const custom = issueOf(
      z.string().refine(() => false, 'Must be tidy'),
      'x',
    );
    expect(formIssueMessage(custom)).toBe(GENERIC_FIELD_MESSAGE);
  });

  it.each([
    ['Persian digits', '۱۲۳'],
    ['Arabic-Indic digits', '١٢٣'],
    ['Persian punctuation', '،؛؟٪'],
    ['a byte-order mark', '\ufeff'],
    ['digits, punctuation and a mark together', '\ufeff۱،؟'],
  ])('does not take %s alone for a Persian sentence', (_label, text) => {
    const issue = issueOf(
      z.string().refine(() => false, text),
      'x',
    );
    expect(issue.message).toBe(text);
    expect(formIssueMessage(issue)).toBe(GENERIC_FIELD_MESSAGE);
  });

  it('keeps a Persian sentence the schema author wrote, on a refine and on a bound', () => {
    expect(
      formIssueMessage(
        issueOf(
          z.string().refine(() => false, 'نام را اصلاح کنید'),
          'x',
        ),
      ),
    ).toBe('نام را اصلاح کنید');
    expect(formIssueMessage(issueOf(z.string().max(1, 'خیلی بلند است'), 'xx'))).toBe(
      'خیلی بلند است',
    );
  });

  it('answers the same at all three entry points', async () => {
    const schema = z.object({ kind: z.enum(['A', 'B']), name: displayText(1, 5) });
    const input = { kind: REFLECTED, name: 'a<b' };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('expected a failed parse');

    const viaMessage = parsed.error.issues.map((issue) => formIssueMessage(issue));
    const viaFields = firstIssuePerField(parsed.error, ['kind', 'name']);
    const viaResolver = await persianResolver(schema)(input, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    const errors = viaResolver.errors as Record<string, { message?: string }>;

    expect(viaMessage).toEqual([
      'یکی از گزینه‌های موجود را انتخاب کنید',
      'نویسه‌های واردشده مجاز نیست',
    ]);
    expect(viaFields).toEqual({
      kind: 'یکی از گزینه‌های موجود را انتخاب کنید',
      name: 'نویسه‌های واردشده مجاز نیست',
    });
    expect(errors.kind?.message).toBe(viaFields.kind);
    expect(errors.name?.message).toBe(viaFields.name);
    expect(JSON.stringify(viaResolver)).not.toContain(REFLECTED);
  });

  it('serves a clean parse its values and no errors', async () => {
    const out = await persianResolver(z.object({ n: z.string() }))({ n: 'a' }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(out).toEqual({ values: { n: 'a' }, errors: {} });
  });
});
