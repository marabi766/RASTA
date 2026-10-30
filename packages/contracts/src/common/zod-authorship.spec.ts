import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import {
  genericLegacyIssue,
  isSchemaAuthored,
  legacyParse,
  refusalIssues,
  type LegacyIssue,
} from './zod-issues';

/**
 * PR #444 r5 F6: whether a message is the schema's own is known by where zod
 * took it from — the issue's own message, the check's or the schema's
 * `error` — never by what it says. legacyParse's zod 3-ordered pass carries an
 * error map that zod calls only where it words an issue itself; it marks the
 * issue and writes nothing. `isSchemaAuthored` is true only for an issue of
 * that pass that zod did not mark and whose message is not the locale's text.
 */

const SWITCH = Symbol.for('@rasta/zod.legacyRunOrder');
const PERSIAN = 'محرمانه';

function refusalOf(schema: z.ZodType, input: unknown): readonly LegacyIssue[] {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal.issues;
}

/** Each issue's path and code and whether it is the schema's own, union options included, sorted. */
function authorship(schema: z.ZodType, input: unknown): [string, boolean][] {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  const out: [string, boolean][] = [];
  const note = (issue: LegacyIssue): string => {
    out.push([`${issue.path.join('.')} ${issue.code}`, isSchemaAuthored(issue)]);
    return '';
  };
  for (const issue of result.refusal.issues) {
    note(issue);
    result.refusal.unionBranches(issue, note);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

describe('isSchemaAuthored: provenance, not content (PR #444 r5 F6)', () => {
  it('is true for each way a schema supplies a message', () => {
    const schema = z.object({
      refined: z.string().refine(() => false, 'پیام ثابت'),
      checked: z.string().min(3, { message: 'دست کم سه' }),
      owned: z.string({ error: 'از طرحواره' }).min(3),
      dynamic: z.number({ error: (issue) => `مقدار ${String(issue.input)} عدد نیست` }),
      added: z.string().superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom', message: 'افزوده' });
      }),
      english: z.string().max(1, 'Too long'),
    });
    const issues = refusalOf(schema, {
      refined: 'x',
      checked: 'x',
      owned: 'x',
      dynamic: PERSIAN,
      added: 'x',
      english: 'xx',
    });
    expect(issues.map((issue) => [issue.path[0], isSchemaAuthored(issue), issue.message])).toEqual([
      ['refined', true, 'پیام ثابت'],
      ['checked', true, 'دست کم سه'],
      ['owned', true, 'از طرحواره'],
      ['dynamic', true, `مقدار ${PERSIAN} عدد نیست`],
      ['added', true, 'افزوده'],
      // The author's, though no form shows it (formIssueMessage wants Persian).
      ['english', true, 'Too long'],
    ]);
  });

  it('is false for zod’s wording, whatever it repeats', () => {
    const schema = z.object({
      choice: z.enum(['A', 'B']),
      literal: z.literal(PERSIAN),
      prefix: z.string().startsWith(PERSIAN),
      strict: z.strictObject({}),
      silent: z.number({ error: () => undefined }),
      copied: z.enum(['A', 'B'], {
        error: (issue) => {
          const written = z.config().localeError?.(issue);
          return typeof written === 'string' ? written : written?.message;
        },
      }),
      superRefined: z.string().superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom' });
      }),
      refined: z.string().refine(() => false),
    });
    const issues = refusalOf(schema, {
      choice: PERSIAN,
      literal: 'x',
      prefix: 'x',
      strict: { [PERSIAN]: 1 },
      silent: PERSIAN,
      copied: PERSIAN,
      superRefined: 'x',
      refined: 'x',
    });
    expect(issues.map((issue) => [issue.path[0], isSchemaAuthored(issue)])).toEqual([
      ['choice', false],
      ['literal', false],
      ['prefix', false],
      ['strict', false],
      ['silent', false],
      ['copied', false],
      ['superRefined', false],
      ['refined', false],
    ]);
    // The messages themselves repeat the Persian text; it is the provenance that says no.
    expect(issues.filter((issue) => issue.message.includes(PERSIAN))).toHaveLength(5);
  });

  it('is false for what a process-wide error map wrote', () => {
    z.config({ customError: (issue) => `سراسری ${String(issue.input)}` });
    try {
      const [issue] = refusalOf(z.object({ a: z.enum(['A', 'B']) }), { a: PERSIAN });
      expect(issue!.zodDefault).toBe(false);
      expect(issue!.message).toBe(`سراسری ${PERSIAN}`);
      expect(isSchemaAuthored(issue!)).toBe(false);
    } finally {
      z.config({ customError: undefined });
    }
  });

  it('follows a union’s options, nested unions included', () => {
    const schema = z.union([
      z.object({
        a: z.enum(['A', 'B']),
        n: z.number({ error: 'عدد بنویسید' }),
        inner: z.union([
          z.object({ c: z.string({ error: 'درونی' }) }),
          z.object({ d: z.boolean() }),
        ]),
      }),
      z.object({ b: z.number() }),
    ]);
    const expected: [string, boolean][] = [
      [' invalid_union', false],
      ['a invalid_enum_value', false],
      ['n invalid_type', true],
      ['inner invalid_union', false],
      ['inner.c invalid_type', true],
      ['inner.d invalid_type', false],
      ['b invalid_type', false],
    ];
    expect(
      authorship(schema, { a: PERSIAN, n: 'x', inner: { c: 1, d: PERSIAN }, b: PERSIAN }),
    ).toEqual(expected.sort(([x], [y]) => x.localeCompare(y)));
  });

  it('is false for a refusal taken from stock zod’s pass, the generic issue and a copy', () => {
    const schema = z.object({ a: z.string().refine(() => false, 'پیام ثابت') });
    const stock = schema.safeParse({ a: 'x' }, { reportInput: true } as never);
    if (stock.success) throw new Error('expected a refusal');
    const fallback = refusalIssues(
      () => {
        throw new Error('the ordered pass failed');
      },
      () => stock.error.issues,
      schema,
    );
    expect(fallback.map((issue) => [issue.message, isSchemaAuthored(issue)])).toEqual([
      ['پیام ثابت', false],
    ]);
    expect(isSchemaAuthored(genericLegacyIssue())).toBe(false);
    const [authored] = refusalOf(schema, { a: 'x' });
    expect(isSchemaAuthored(authored!)).toBe(true);
    expect(isSchemaAuthored({ ...authored! })).toBe(false);
  });

  it('changes no message and no zodDefault: the marking pass words every issue as an unmarked one', () => {
    const cases: [z.ZodType, unknown][] = [
      [
        z.object({ a: z.enum(['A', 'B']), b: z.literal('L'), c: z.string().endsWith('z') }),
        { a: PERSIAN, b: 1, c: PERSIAN },
      ],
      [z.object({ a: z.string().refine(() => false, 'پیام') }).strict(), { a: 'x', [PERSIAN]: 1 }],
      [
        z.union([z.object({ a: z.number() }), z.object({ b: z.string().max(1, 'کوتاه') })]),
        { a: 'x', b: 'yy' },
      ],
      [z.array(z.number().int().max(3)).min(2), [1.5]],
      [z.record(z.string(), z.number({ error: () => undefined })), { k: PERSIAN }],
    ];
    for (const [schema, input] of cases) {
      const unmarked = refusalIssues(
        () => schema.safeParse(input, { reportInput: true, [SWITCH]: true } as never),
        () => [],
        schema,
      );
      expect(JSON.stringify(refusalOf(schema, input))).toBe(JSON.stringify(unmarked));
    }
  });
});

describe('zod calls the marking error map wherever it words an issue', () => {
  // `finalizeIssue` asks the parse's error map (`ctx.error`) only after the
  // issue's own message, the check's and the schema's `error`. Every call
  // passes the parse's context, in both builds: an issue finalized without it
  // would carry the locale's text unmarked (then the locale comparison is the
  // only guard), or a process-wide map's text, unmarked and believed.
  const v4 = join(dirname(require.resolve('zod/package.json')), 'v4');

  it.each(['js', 'cjs'])('in the %s build', (ext) => {
    const calls = readdirSync(v4, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith(`.${ext}`))
      .flatMap((file) => {
        const text = readFileSync(join(v4, file), 'utf8');
        // Every mention, then its arguments (one level of nested parentheses).
        const mentions = text.split(/finalizeIssue\)?\(/).length - 1;
        const args = [...text.matchAll(/finalizeIssue\)?\(((?:[^()]|\([^()]*\))*)\)/g)].map(
          (match) => match[1]!.replace(/\s+/g, ' '),
        );
        expect([file, args.length]).toEqual([file, mentions]);
        return args.map((each) => `${file}: ${each}`);
      });
    const definitions = calls.filter((call) => /^core\/util\.c?js: iss, ctx, config$/.test(call));
    const uses = calls.filter((call) => !definitions.includes(call));
    expect(definitions).toHaveLength(1);
    expect(uses.length).toBeGreaterThanOrEqual(10);
    expect(uses.filter((call) => !/: iss, ctx, core\.config\(\)$/.test(call))).toEqual([]);
  });
});
