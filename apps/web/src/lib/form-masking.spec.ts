/**
 * @jest-environment node
 */
import { join } from 'node:path';

import { firstIssues } from '@/server/maintenance-commands';

import {
  AUTHORED_IN_FALLBACK,
  CONTEXTS,
  POSITIONS,
  SENTINELS,
  VARIANTS,
  dynamicMessage,
  globalErrorMapCase,
  maskingMatrix,
  stockFallbackCase,
  stockFallbackSchema,
  type MaskingCase,
  type Variant,
  type Wording,
} from '../test/form-masking-matrix';
import { ZOD_BUILDS, runInZodBuild } from '../test/zod-builds';
import { firstIssuePerField, GENERIC_FIELD_MESSAGE } from './form-issues';

/**
 * PR #444 r5 F6: who wrote a message decides whether a form may show it —
 * never what the message says. A default of zod's that repeats a Persian
 * value received, Persian options, a Persian literal or prefix, or a Persian
 * unknown key is zod's all the same, and is masked with the code's own
 * sentence (`formIssueMessage` rule 2); only a message the schema supplied
 * passes. Seven variants × root, nested, array, record × a plain field, a
 * union option and a union in a union option × Latin and Persian parameters
 * × Latin and Persian values: 336 cases, here in Jest and in both builds of
 * zod (`zod-builds.ts`), through the resolver (first issue and
 * `criteriaMode: 'all'`), `firstIssuePerField` and the branch trees, with
 * every error object and tree serialized and inspected.
 *
 * Explicit exceptions, as before: a record key stays in paths (it is the
 * form's field name), and a message the author built from the input repeats
 * it, at the top level and in an option alike.
 */

const MATRIX = join(__dirname, '../test/form-masking-matrix.ts');

const CHOOSE = 'یکی از گزینه‌های موجود را انتخاب کنید';
const CHARACTERS = 'نویسه‌های واردشده مجاز نیست';
const NUMBER = 'یک عدد صحیح و معتبر وارد کنید';

/** The code's own sentence for each variant (addendum B): no value, option or key in it. */
const MASKED: Record<Variant, string> = {
  'enum received': CHOOSE,
  'enum options in a type error': GENERIC_FIELD_MESSAGE,
  'literal expected': CHOOSE,
  'strict object unknown key': GENERIC_FIELD_MESSAGE,
  startsWith: CHARACTERS,
  endsWith: CHARACTERS,
  includes: CHARACTERS,
};

/** Every sentence a masked form message may be (the other fields fail on a number or a union). */
const ALLOWED = new Set([GENERIC_FIELD_MESSAGE, CHOOSE, CHARACTERS, NUMBER]);

const SENTINEL_TEXTS = [...Object.values(SENTINELS.fa), ...Object.values(SENTINELS.latin)];
/** A sentinel's distinctive word, a zod English word, or the global error map's text. */
const LEAK = /SECRET|پنهان|محرمانه|سراسری|Invalid|Expected|expected|received|Unrecognized|must /;
const LATIN_LETTER = /[A-Za-z]/;

/** Each case's departures from masking, as `where: what` lines; none expected. */
function maskingViolations(cases: readonly MaskingCase[]): string[] {
  const out: string[] = [];
  for (const each of cases) {
    const where = `${each.variant} / ${each.position} / ${each.context} / ${each.params} params / ${each.received} value / ${each.wording}`;
    for (const text of [...each.texts, ...each.messages]) {
      const leak =
        text.match(LEAK)?.[0] ?? SENTINEL_TEXTS.find((sentinel) => text.includes(sentinel));
      if (leak !== undefined) out.push(`${where}: shows ${leak}`);
    }
    for (const message of each.messages) {
      if (LATIN_LETTER.test(message) || !ALLOWED.has(message)) out.push(`${where}: ${message}`);
    }
    out.push(...placeViolations(each, where, MASKED[each.variant]));
  }
  return out;
}

/** The variant's own field: `text` as its first issue, in every `criteriaMode: 'all'` entry and in the branch tree. */
function placeViolations(each: MaskingCase, where: string, text: string): string[] {
  const out: string[] = [];
  if (each.shown !== text) out.push(`${where}: shown ${String(each.shown)}`);
  if (each.shownAll.length === 0 || each.shownAll.some((message) => message !== text)) {
    out.push(`${where}: criteriaMode all ${JSON.stringify(each.shownAll)}`);
  }
  if (
    each.context !== 'field' &&
    (each.branchIssues === 0 ||
      each.shownInTree.length === 0 ||
      each.shownInTree.some((message) => message !== text))
  ) {
    out.push(`${where}: branch tree ${JSON.stringify(each.shownInTree)}`);
  }
  return out;
}

function expectMasked(cases: readonly MaskingCase[]): void {
  expect(cases.length).toBeGreaterThan(0);
  expect(maskingViolations(cases)).toEqual([]);
}

/** What the author's message is shown as, in every place a form shows the variant's issue. */
function expectShownAsWritten(
  cases: readonly MaskingCase[],
  written: (each: MaskingCase) => string,
): void {
  expect(cases.length).toBeGreaterThan(0);
  const out = cases.flatMap((each) =>
    placeViolations(
      each,
      `${each.variant} / ${each.position} / ${each.context} / ${each.params} / ${each.received}`,
      written(each),
    ),
  );
  expect(out).toEqual([]);
}

/** The value the variant's check was raised on, as the author's function saw it. */
function inputOf(each: MaskingCase): unknown {
  if (each.variant === 'enum options in a type error') return 7;
  if (each.variant === 'strict object unknown key') return { ok: 'x' };
  return SENTINELS[each.received].received;
}

const AUTHORED = 'گزینه درست را از فهرست انتخاب کنید';

/** The matrix's entry points, as the Jest run calls them. */
const IN_JEST: Record<string, (args?: never) => Promise<unknown>> = {
  maskingMatrix,
  globalErrorMapCase,
  stockFallbackCase,
};

type Run = <T>(name: string, args?: unknown) => Promise<T>;

const RUNS: [string, Run][] = [
  ['Jest', async <T>(name: string, args?: unknown) => (await IN_JEST[name]!(args as never)) as T],
  ...ZOD_BUILDS.map((build): [string, Run] => [
    `zod's ${build} build`,
    async <T>(name: string, args?: unknown) => runInZodBuild<T>(build, MATRIX, name, args),
  ]),
];

describe.each(RUNS)('form messages decided by provenance (PR #444 r5 F6), %s', (_run, run) => {
  const matrix = (wording: Wording) => run<MaskingCase[]>('maskingMatrix', { wording });

  it('masks every zod default that repeats a Persian or Latin value, option, literal, prefix or key', async () => {
    const cases = await matrix({ kind: 'default' });
    expect(cases).toHaveLength(VARIANTS.length * POSITIONS.length * CONTEXTS.length * 4);
    expectMasked(cases);
  });

  it('masks an author’s function that returns nothing, and one that returns zod’s own text', async () => {
    expectMasked(await matrix({ kind: 'returns nothing' }));
    expectMasked(await matrix({ kind: "zod's own text" }));
  });

  it('masks what a process-wide error map wrote, though zod’s locale did not', async () => {
    const cases = await run<MaskingCase[]>('globalErrorMapCase');
    expect(cases).toHaveLength(CONTEXTS.length);
    expectMasked(cases);
  });

  it('masks the author’s message in a refusal taken from stock zod’s pass (fails closed)', async () => {
    const { errors, fields } = await run<{
      errors: [string, string][];
      fields: Record<string, string>;
    }>('stockFallbackCase');
    expect(errors.length).toBeGreaterThan(0);
    for (const [, message] of errors) expect(ALLOWED.has(message)).toBe(true);
    expect(JSON.stringify({ errors, fields })).not.toMatch(LEAK);
    expect(JSON.stringify({ errors, fields })).not.toContain(AUTHORED_IN_FALLBACK);
  });

  it('shows a Persian message the schema wrote as written, static or built from the input', async () => {
    expectShownAsWritten(await matrix({ kind: 'static', text: AUTHORED }), () => AUTHORED);
    // The author's own sentence repeats the input: shown, as before (the explicit exception).
    expectShownAsWritten(await matrix({ kind: 'dynamic' }), (each) =>
      dynamicMessage(inputOf(each)),
    );
  });
});

describe('the one formatter, and its server-side name', () => {
  it('is what the maintenance command parsers call (maintenance-commands.ts firstIssues)', () => {
    expect(firstIssues).toBe(firstIssuePerField);
  });

  it('reaches the stock fallback case through stock zod’s refusal only (D-078 addendum B)', () => {
    const { schema, input } = stockFallbackSchema();
    expect(schema.safeParse(input).success).toBe(false);
    expect(
      schema.safeParse(input, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never).success,
    ).toBe(true);
  });
});
