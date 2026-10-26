import { z } from 'zod';

import type { FuzzReport } from './__tests__/zod-differential';
import { releaseStockZod, runInBuild, type Build } from './__tests__/zod-stock-oracle';
import { inspect } from 'node:util';

import {
  describeLegacyRefusal,
  genericLegacyIssue,
  legacyParse,
  legacyParseAsync,
  refusalIssues,
  type LegacyIssue,
} from './zod-issues';

/**
 * D-078 (Codex PR-444 r3 F3): acceptance and every accepted value are stock
 * zod 4's, by construction. The patch's zod 3 run order is off unless a parse
 * passes its switch, and only legacyParse does, on input stock zod already
 * refused, for the wording of that refusal. Judged against an unmodified zod
 * 4.6.7 loaded on its own (`__tests__/zod-stock-oracle.ts`), in both builds.
 */

const BUILDS: Build[] = ['cjs', 'esm'];

afterAll(releaseStockZod);

type Outcome = { kind: string; issues?: unknown; codes?: string[]; data?: string };

describe.each(BUILDS)('stock zod decides, in the %s build (D-078)', (build) => {
  it('refuses Codex PR-444 r3 F3 and its object, union, pipe and .and() wrappers, as stock zod does', () => {
    const cases = runInBuild<
      {
        name: string;
        stock: Outcome;
        stockRefinementCalls: number;
        plain: Outcome;
        plainRefinementCalls: number;
        switched: string;
        legacy: { kind: string; issues?: unknown };
        stockTranslated: { kind: string; issues?: unknown };
        inputUnchanged: boolean;
      }[]
    >(build, 'f3');
    expect(cases.map(({ name }) => name)).toEqual([
      'direct',
      'under an object',
      'under a union',
      'under a pipe',
      'under .and()',
    ]);
    for (const each of cases) {
      expect([each.name, each.stock.kind]).toEqual([each.name, 'refused']);
      // An ordinary parse is stock zod's: same issues, and the refinement ran.
      expect([each.name, each.plain, each.plainRefinementCalls]).toEqual([
        each.name,
        each.stock,
        each.stockRefinementCalls,
      ]);
      // The zod 3-ordered pass alone would accept it (the intersection
      // reconciles the key issue away): legacyParse falls back to stock zod's
      // refusal instead.
      expect([each.name, each.switched]).toEqual([each.name, 'accepted']);
      expect([each.name, each.legacy]).toEqual([each.name, each.stockTranslated]);
      expect(each.legacy.kind).toBe('refused');
      expect(each.inputUnchanged).toBe(true);
    }
  });

  it('parses as stock zod unless switched, sync and async; switched, in zod 3’s order', () => {
    const cases = runInBuild<
      {
        name: string;
        stock: Outcome;
        plain: Outcome;
        plainAsync: Outcome;
        switched: Outcome;
        switchedAsync: Outcome;
        legacy: { kind: string; issues: { code: string }[] };
      }[]
    >(build, 'rules');
    const zod3: Record<string, string[]> = {
      int: ['invalid_type', 'too_small', 'custom'],
      'z.int()': ['invalid_type', 'too_small', 'custom'],
      infinity: ['invalid_type', 'too_big', 'custom'],
      'transform issue': ['custom', 'custom'],
      'refused before a transform': ['too_small'],
      union: ['too_small', 'custom'],
    };
    expect(cases.map(({ name }) => name)).toEqual(Object.keys(zod3));
    for (const each of cases) {
      expect([each.name, each.plain]).toEqual([each.name, each.stock]);
      expect([each.name, each.plainAsync]).toEqual([each.name, each.stock]);
      expect([each.name, each.switched.codes]).toEqual([each.name, zod3[each.name]]);
      expect([each.name, each.switchedAsync.codes]).toEqual([each.name, zod3[each.name]]);
      expect(each.legacy.kind).toBe('refused');
    }
  });

  it('reaches every way zod runs a nested schema when switched, and none when not', () => {
    const cases = runInBuild<
      { name: string; plain: string; plainCalls: number; switched: string; switchedCalls: number }[]
    >(build, 'reaches');
    expect(cases).toHaveLength(16);
    for (const each of cases) {
      expect(each).toEqual({
        name: each.name,
        plain: 'refused',
        plainCalls: 0,
        switched: 'refused',
        switchedCalls: 1,
      });
    }
  });

  it('keeps the switch to the parse that set it (addendum C)', () => {
    const result = runInBuild<{
      nested: { codes: string[]; innerCalls: number }[];
      legacy: { kind: string };
      switchedCodes: string[];
      ordinaryCodes: string[];
      stockCodes: string;
      refinementCalls: number;
    }>(build, 'isolation');
    // The refinement ran in both of legacyParse's passes; the parse it started
    // inside the switched one ran as stock zod (its refinement skipped).
    expect(result.legacy.kind).toBe('refused');
    expect(result.nested).toEqual([
      { codes: ['invalid_type'], innerCalls: 0 },
      { codes: ['invalid_type'], innerCalls: 0 },
    ]);
    // 40 async parses of one schema, switched and ordinary interleaved.
    expect(result.switchedCodes).toEqual(['invalid_type,too_small,custom']);
    expect(result.ordinaryCodes).toEqual([result.stockCodes]);
    expect(result.refinementCalls).toBe(20);
  });

  it('refuses an oversized array before any element, in both passes (GHSA-mrhx-c7xc-m3w5)', () => {
    expect(runInBuild(build, 'ghsa')).toEqual({
      stock: ['too_big', 0],
      plain: ['too_big', 0],
      switched: ['too_big', 0],
      legacy: ['too_big', 0],
    });
  });

  it('agrees with stock zod on 75,000 random compositions, values and issues included', () => {
    const report = runInBuild<FuzzReport>(build, 'fuzz', { seed: 444, schemas: 3000, inputs: 25 });
    expect(report.mismatches).toEqual([]);
    expect(report.mismatchCount).toBe(0);
    expect(report.cases).toBe(75_000);
    expect(report.asyncCases).toBeGreaterThan(18_000);
    // Both answers occur often, and the F3 class (only the zod 3-ordered pass
    // would accept) is in the sample: legacyParse refused each of them.
    expect(report.stock.accepted).toBeGreaterThan(20_000);
    expect(report.stock.refused).toBeGreaterThan(20_000);
    expect(report.switchedAcceptedStockRefused).toBeGreaterThan(0);
    // Where stock zod throws, legacyParse refuses with the generic issue (addendum C).
    expect(report.stock.threw).toBeGreaterThan(0);
  });

  it('agrees with stock safeParseAsync on 75,000 compositions with every callback async (r4 F4)', () => {
    const report = runInBuild<FuzzReport & { unhandledRejections: number }>(build, 'fuzzAsync', {
      seed: 444,
      schemas: 3000,
      inputs: 25,
      phase: 'awaited',
    });
    expect(report.mismatches).toEqual([]);
    expect(report.mismatchCount).toBe(0);
    expect(report.cases).toBe(75_000);
    expect(report.asyncCases).toBe(75_000);
    expect(report.stock.accepted).toBeGreaterThan(20_000);
    expect(report.stock.refused).toBeGreaterThan(20_000);
    // A rejected stock parse is the generic refusal; the F3 class is refused.
    expect(report.stock.threw).toBeGreaterThan(0);
    expect(report.switchedAcceptedStockRefused).toBeGreaterThan(0);
    // Awaited, nothing is left behind to reject later.
    expect(report.unhandledRejections).toBe(0);
  });

  it('refuses those schemas in the synchronous legacyParse as stock safeParse does, 25,000 cases', () => {
    const report = runInBuild<FuzzReport>(build, 'fuzzAsync', {
      seed: 444,
      schemas: 1000,
      inputs: 25,
      phase: 'sync',
    });
    expect(report.mismatches).toEqual([]);
    expect(report.mismatchCount).toBe(0);
    expect(report.cases).toBe(25_000);
    // zod's async error, rethrown, in most of them.
    expect(report.stock.threw).toBeGreaterThan(5_000);
  });

  it('resolves each async callback kind as stock safeParseAsync, and refuses it synchronously as stock zod (r4 F4)', () => {
    type Side = { kind: string; data?: string; issues?: unknown; message?: string };
    const cases = runInBuild<
      {
        name: string;
        valid: { stock: Side; legacy: Side; stockSync: Side; legacySync: Side };
        invalid: {
          stock: Side;
          legacy: Side;
          stockTranslated: Side;
          stockSync: Side;
          legacySync: Side;
        };
        inputUnchanged: boolean;
      }[]
    >(build, 'asyncKinds');
    expect(cases.map(({ name }) => name)).toEqual([
      'refine',
      'superRefine',
      'check',
      'transform',
      'preprocess',
    ]);
    const asyncError = {
      kind: 'threw',
      message: 'Encountered Promise during synchronous parse. Use .parseAsync() instead.',
    };
    const stockSyncThrows = new Set<string>();
    for (const each of cases) {
      expect([each.name, each.valid.stock.kind]).toEqual([each.name, 'accepted']);
      expect([each.name, each.valid.legacy]).toEqual([each.name, each.valid.stock]);
      expect([each.name, each.invalid.stock.kind]).toEqual([each.name, 'refused']);
      expect([each.name, each.invalid.legacy]).toEqual([each.name, each.invalid.stockTranslated]);
      expect([each.name, each.invalid.legacy.kind]).toEqual([each.name, 'refused']);
      for (const side of [each.valid, each.invalid]) {
        // Synchronously, stock zod throws: its async error, which legacyParse
        // rethrows, or — where its compiled object parser reads the Promise
        // of an async transform or preprocess — a TypeError, which
        // legacyParse turns into the generic refusal (addendum C).
        expect(side.stockSync.kind).toBe('threw');
        expect([each.name, side.legacySync]).toEqual([
          each.name,
          side.stockSync.message === asyncError.message
            ? asyncError
            : { kind: 'refused', issues: [{ path: '', code: 'custom', message: 'Invalid input' }] },
        ]);
        stockSyncThrows.add(`${each.name}: ${side.stockSync.message}`);
      }
      expect(each.inputUnchanged).toBe(true);
    }
    expect([...stockSyncThrows]).toEqual([
      `refine: ${asyncError.message}`,
      `superRefine: ${asyncError.message}`,
      `check: ${asyncError.message}`,
      "transform: Cannot read properties of undefined (reading 'length')",
      "preprocess: Cannot read properties of undefined (reading 'length')",
    ]);
  });

  it('refuses Codex PR-444 r3 F3 with an async refinement through legacyParseAsync, as stock zod does', () => {
    const cases = runInBuild<
      {
        name: string;
        stock: Outcome;
        stockRefinementCalls: number;
        plain: Outcome;
        plainRefinementCalls: number;
        switched: string;
        legacy: { kind: string };
        stockTranslated: { kind: string };
        syncLegacy: { kind: string };
        inputUnchanged: boolean;
      }[]
    >(build, 'f3Async');
    expect(cases).toHaveLength(5);
    for (const each of cases) {
      expect([each.name, each.stock.kind]).toEqual([each.name, 'refused']);
      expect([each.name, each.plain, each.plainRefinementCalls]).toEqual([
        each.name,
        each.stock,
        each.stockRefinementCalls,
      ]);
      expect([each.name, each.switched]).toEqual([each.name, 'accepted']);
      expect([each.name, each.legacy]).toEqual([each.name, each.stockTranslated]);
      expect(each.legacy.kind).toBe('refused');
      expect(each.syncLegacy.kind).toBe('threw');
      expect(each.inputUnchanged).toBe(true);
    }
  });

  it('keeps async parses apart: reentrant, 40 interleaved, no input mutated (addendum D)', () => {
    const result = runInBuild<{
      reentrant: { kind: string; issues: { code: string }[] };
      nested: { kind: string; issues: { code: string }[] }[];
      sameAsAlone: number;
      kinds: number;
      refinementCalls: number;
      mutated: number;
    }>(build, 'asyncIsolation');
    // A legacyParseAsync inside a callback of another, in both of its passes:
    // each nested one is its own, complete, zod 3-ordered refusal.
    expect(result.reentrant.kind).toBe('refused');
    expect(result.nested).toHaveLength(2);
    for (const nested of result.nested) {
      expect(nested.issues.map((issue) => issue.code)).toEqual([
        'invalid_type',
        'too_small',
        'custom',
      ]);
    }
    // 40 at once, refused and accepted interleaved: each as when run alone.
    expect(result.sameAsAlone).toBe(40);
    expect(result.kinds).toBeGreaterThan(1);
    // The refinement: once per accepted input (10), twice per input it
    // refused (10, both passes), once per input refused before it (20, the
    // switched pass only).
    expect(result.refinementCalls).toBe(50);
    expect(result.mutated).toBe(0);
  });
});

describe('legacyParse fails closed (D-078, addendum B)', () => {
  const brief = (issues: readonly LegacyIssue[]) =>
    issues.map(({ path, code, message }) => [path.join('.'), code, message]);
  const schema = z.object({ n: z.number().int().min(1), s: z.string() }).refine(() => false, {
    message: 'enclosing',
  });
  const input = { n: 0.5, s: 's' };
  const stockIssues = () => {
    const result = schema.safeParse(input, { reportInput: true });
    if (result.success) throw new Error('expected a refusal');
    return result.error.issues;
  };
  const ordered = () =>
    schema.safeParse(input, { reportInput: true, [Symbol.for('@rasta/zod.legacyRunOrder')]: true });
  const STOCK = [['n', 'invalid_type', 'Expected integer, received float']];
  const ZOD3 = [
    ['n', 'invalid_type', 'Expected integer, received float'],
    ['n', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'enclosing'],
  ];

  it('words a refusal in zod 3’s order when the second pass refuses too', () => {
    expect(brief(refusalIssues(ordered, stockIssues, schema))).toEqual(ZOD3);
    const result = legacyParse(schema, input);
    expect(result.success).toBe(false);
    expect(brief(result.refusal?.issues ?? [])).toEqual(ZOD3);
  });

  it('keeps stock zod’s refusal when the second pass throws', () => {
    let calls = 0;
    const throwing = z.object({ n: z.number().int() }).refine(() => {
      calls += 1;
      if (calls > 1) throw new Error('second pass');
      return false;
    }, 'first pass');
    // Stock: the integer stops the parse, the refinement never runs; so make it
    // run in both: a value that passes the integer.
    const result = legacyParse(throwing, { n: 1 });
    expect(calls).toBe(2);
    expect(result.success).toBe(false);
    expect(brief(result.refusal?.issues ?? [])).toEqual([['', 'custom', 'first pass']]);
  });

  it('keeps stock zod’s refusal when the second pass accepts (F3)', () => {
    const left = z
      .object({ a: z.string() })
      .strict()
      .transform((value) => value)
      .refine(() => false, 'never allowed');
    const f3 = z.intersection(left, z.object({ b: z.string() }));
    const value = { a: 'a', b: 'b' };
    expect(
      f3.safeParse(value, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never).success,
    ).toBe(true);
    const result = legacyParse(f3, value);
    expect(result.success).toBe(false);
    expect(brief(result.refusal?.issues ?? [])).toEqual([['', 'custom', 'never allowed']]);
    expect(value).toEqual({ a: 'a', b: 'b' });
  });

  it('keeps stock zod’s refusal when translating the second pass throws or says nothing', () => {
    type Translate = Parameters<NonNullable<Parameters<typeof refusalIssues>[3]>>[0];
    let call = 0;
    const throwsFirst =
      (translate: Translate): Translate =>
      (issues, s) => {
        call += 1;
        if (call === 1) throw new Error('translation');
        return translate(issues, s);
      };
    expect(brief(refusalIssues(ordered, stockIssues, schema, throwsFirst))).toEqual(STOCK);
    expect(call).toBe(2);
    call = 0;
    const emptyFirst =
      (translate: Translate): Translate =>
      (issues, s) => {
        call += 1;
        return call === 1 ? [] : translate(issues, s);
      };
    expect(brief(refusalIssues(ordered, stockIssues, schema, emptyFirst))).toEqual(STOCK);
    expect(call).toBe(2);
  });

  it('says one fixed generic issue when neither refusal can be translated, never the value', () => {
    const generic = [genericLegacyIssue()];
    expect(
      refusalIssues(ordered, stockIssues, schema, () => () => {
        throw new Error('translation');
      }),
    ).toEqual(generic);
    expect(refusalIssues(ordered, stockIssues, schema, () => () => [])).toEqual(generic);
    expect(
      refusalIssues(
        () => {
          throw new Error('second pass');
        },
        () => {
          throw new Error('stock issues');
        },
        schema,
      ),
    ).toEqual(generic);
    expect(generic).toEqual([
      { code: 'custom', path: [], message: 'Invalid input', zodDefault: true },
    ]);
  });

  it('never mutates the input, in either pass', () => {
    const value = { n: 0.5, s: 's', nested: { list: [1, 2] } };
    const before = structuredClone(value);
    const nested = z.object({
      n: z.number().int(),
      s: z.string().transform((text) => text.toUpperCase()),
      nested: z.object({ list: z.array(z.number()).transform((list) => list.reverse()) }),
    });
    legacyParse(nested, value);
    expect(value).toEqual(before);
  });
});

describe('legacyParseAsync fails closed the same way (r4 F4, addenda B and C)', () => {
  const brief = (issues: readonly LegacyIssue[]) =>
    issues.map(({ path, code, message }) => [path.join('.'), code, message]);
  const refusalOf = async (schema: z.ZodType, input: unknown) => {
    const result = await legacyParseAsync(schema, input);
    if (result.success) throw new Error('expected a refusal');
    return result.refusal;
  };

  it('returns stock zod’s success unchanged, values included', async () => {
    const schema = z.object({
      n: z.string().transform(async (value) => Number(value)),
      d: z.string().prefault('x'),
    });
    const result = await legacyParseAsync(schema, { n: '5' });
    expect(result).toEqual({ success: true, data: await schema.parseAsync({ n: '5' }) });
  });

  it('words a refusal in zod 3’s order when the awaited second pass refuses too', async () => {
    const schema = z
      .object({ n: z.number().int().min(1), s: z.string() })
      .refine(async () => false, { message: 'enclosing' });
    expect(brief((await refusalOf(schema, { n: 0.5, s: 's' })).issues)).toEqual([
      ['n', 'invalid_type', 'Expected integer, received float'],
      ['n', 'too_small', 'Number must be greater than or equal to 1'],
      ['', 'custom', 'enclosing'],
    ]);
  });

  it('keeps stock zod’s refusal when the awaited second pass rejects', async () => {
    let calls = 0;
    const rejecting = z.object({ n: z.number().int() }).refine(async () => {
      calls += 1;
      if (calls > 1) throw new Error('second pass');
      return false;
    }, 'first pass');
    expect(brief((await refusalOf(rejecting, { n: 1 })).issues)).toEqual([
      ['', 'custom', 'first pass'],
    ]);
    expect(calls).toBe(2);
  });

  it('keeps stock zod’s refusal when the awaited second pass accepts (F3)', async () => {
    const left = z
      .object({ a: z.string() })
      .strict()
      .transform(async (value) => value)
      .refine(async () => false, 'never allowed');
    const f3 = z.intersection(left, z.object({ b: z.string() }));
    const value = { a: 'a', b: 'b' };
    expect(
      (await f3.safeParseAsync(value, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never))
        .success,
    ).toBe(true);
    expect(brief((await refusalOf(f3, value)).issues)).toEqual([['', 'custom', 'never allowed']]);
    expect(value).toEqual({ a: 'a', b: 'b' });
  });

  it('says the generic issue when neither refusal can be worded', async () => {
    const VALUE = 'SENTINEL-042-value';
    const refusal = await refusalOf(
      z.object({
        a: z.string().refine(async () => false, {
          error: () => {
            throw new Error(VALUE);
          },
        }),
      }),
      { a: VALUE },
    );
    expect(refusal.issues).toEqual([genericLegacyIssue()]);
    expect(inspect(refusal) + JSON.stringify(refusal)).not.toContain(VALUE);
  });

  it('never mutates the input, in either awaited pass', async () => {
    const value = { n: 0.5, s: 's', nested: { list: [1, 2] } };
    const before = structuredClone(value);
    const nested = z.object({
      n: z.number().int(),
      s: z.string().transform(async (text) => text.toUpperCase()),
      nested: z.object({ list: z.array(z.number()).transform(async (list) => list.reverse()) }),
    });
    await legacyParseAsync(nested, value);
    expect(value).toEqual(before);
  });
});

describe('a first pass that throws is the generic refusal, sync and async (addendum C)', () => {
  const VALUE = 'SENTINEL-042-thrown';
  const throwing = () =>
    z.object({
      a: z.string().transform(() => {
        throw new Error(VALUE);
      }),
    });

  it('legacyParse: never an acceptance, never the error’s text', () => {
    const schema = throwing();
    expect(() => schema.safeParse({ a: 'x' })).toThrow(VALUE);
    const result = legacyParse(schema, { a: 'x' });
    expect(result.success).toBe(false);
    expect(result.refusal?.issues).toEqual([genericLegacyIssue()]);
    expect(inspect(result) + JSON.stringify(result)).not.toContain(VALUE);
  });

  it('legacyParseAsync: a rejected first pass the same way', async () => {
    const schema = z.object({
      a: z.string().refine(async () => {
        throw new Error(VALUE);
      }),
    });
    await expect(schema.safeParseAsync({ a: 'x' })).rejects.toThrow(VALUE);
    const result = await legacyParseAsync(schema, { a: 'x' });
    expect(result.success).toBe(false);
    expect(result.refusal?.issues).toEqual([genericLegacyIssue()]);
    expect(inspect(result) + JSON.stringify(result)).not.toContain(VALUE);
    // The synchronous one throws as legacyParse did not: it is not zod's async error.
    expect(legacyParse(throwing(), { a: 'x' }).refusal?.issues).toEqual([genericLegacyIssue()]);
  });

  it('legacyParse rethrows zod’s own async error: an async schema refused as stock safeParse refuses it', () => {
    const schema = z.object({ a: z.string().refine(async () => true) });
    expect(() => schema.safeParse({ a: 'x' })).toThrow(z.core.$ZodAsyncError);
    expect(() => legacyParse(schema, { a: 'x' })).toThrow(z.core.$ZodAsyncError);
  });

  it('refuses the async schema stock zod’s compiled parser trips over, rather than throw its TypeError', async () => {
    // Stock zod 4.6.7, synchronously: an async preprocess inside an object
    // makes its compiled object parser read a Promise, a TypeError instead of
    // $ZodAsyncError (session repro). Not zod's async error, so the generic
    // refusal; awaited, the schema parses.
    const schema = z.object({
      a: z.preprocess(async (value) => value, z.object({ b: z.string() })),
    });
    expect(() => schema.safeParse({ a: { b: 'x' } })).toThrow(TypeError);
    expect(legacyParse(schema, { a: { b: 'x' } }).refusal?.issues).toEqual([genericLegacyIssue()]);
    expect(await legacyParseAsync(schema, { a: { b: 'x' } })).toEqual({
      success: true,
      data: { a: { b: 'x' } },
    });
  });
});

describe('a refused union keeps its options, beside its issue (r4 F5)', () => {
  const objects = z.union([z.object({ a: z.string() }), z.object({ b: z.enum(['X1', 'Y1']) })]);
  const refusalOf = (schema: z.ZodType, input: unknown) => {
    const result = legacyParse(schema, input);
    if (result.success) throw new Error('expected a refusal');
    return result.refusal;
  };
  const word = (issue: LegacyIssue) => `${issue.code}@${issue.path.join('.')}`;

  it('translates each option at the union’s full path, nested unions the same way', () => {
    const schema = z.object({
      items: z.array(
        z.union([z.object({ kind: z.literal('x'), inner: objects }), z.object({ e: z.number() })]),
      ),
    });
    const refusal = refusalOf(schema, { items: [{ kind: 'x', inner: { a: 1, b: 'Z' }, e: 'z' }] });
    expect(refusal.issues.map(({ path, code }) => [path.join('.'), code])).toEqual([
      ['items.0', 'invalid_union'],
    ]);
    expect(refusal.unionBranches(refusal.issues[0]!, word)).toEqual([
      [
        {
          path: ['items', 0, 'inner'],
          code: 'invalid_union',
          message: 'invalid_union@items.0.inner',
          branches: [
            [
              {
                path: ['items', 0, 'inner', 'a'],
                code: 'invalid_type',
                message: 'invalid_type@items.0.inner.a',
              },
            ],
            [
              {
                path: ['items', 0, 'inner', 'b'],
                code: 'invalid_enum_value',
                message: 'invalid_enum_value@items.0.inner.b',
              },
            ],
          ],
        },
      ],
      [{ path: ['items', 0, 'e'], code: 'invalid_type', message: 'invalid_type@items.0.e' }],
    ]);
  });

  it('hands the consumer’s wording the translated issue, and keeps nothing else', () => {
    const refusal = refusalOf(objects, { a: 1, b: 'SENTINEL-042-enum' });
    const seen: LegacyIssue[] = [];
    const tree = refusal.unionBranches(refusal.issues[0]!, (issue) => {
      seen.push(issue);
      return 'worded';
    });
    // The wording sees what a top-level issue carries (zod 3's fields)…
    expect(seen.map((issue) => issue.code)).toEqual(['invalid_type', 'invalid_enum_value']);
    expect(seen[1]).toMatchObject({ options: ['X1', 'Y1'], received: 'SENTINEL-042-enum' });
    // …and the tree keeps only path, code and its answer.
    const text = JSON.stringify(tree) + inspect(tree, { depth: null, showHidden: true });
    expect(text).not.toMatch(/SENTINEL-042-enum|X1|Y1|received|options/);
    expect(Object.isFrozen(tree![0]![0])).toBe(true);
  });

  it('answers only for a union issue of that refusal', () => {
    const refusal = refusalOf(objects, { a: 1 });
    const other = refusalOf(objects, { a: 1 });
    expect(refusal.unionBranches(other.issues[0]!, word)).toBeUndefined();
    expect(refusal.unionBranches({ ...refusal.issues[0]! }, word)).toBeUndefined();
    const plain = refusalOf(z.object({ a: z.string() }), { a: 1 });
    expect(plain.unionBranches(plain.issues[0]!, word)).toBeUndefined();
    // A union zod 3 reported through its first check-only option has no tree:
    // that option's issues are the refusal's own.
    const checks = refusalOf(z.union([z.string().min(5), z.number()]), 'ab');
    expect(checks.issues.map((issue) => issue.code)).toEqual(['too_small']);
    expect(checks.unionBranches(checks.issues[0]!, word)).toBeUndefined();
  });

  it('leaves the refusal’s issues, JSON and inspection exactly as without it', () => {
    const refusal = refusalOf(z.object({ payload: objects }), { payload: { a: 1, b: 'Z' } });
    expect(refusal.issues).toEqual([
      { code: 'invalid_union', path: ['payload'], message: 'Invalid input', zodDefault: true },
    ]);
    expect(Object.keys(refusal.issues[0]!)).toEqual(['code', 'path', 'message', 'zodDefault']);
    expect(JSON.stringify(refusal)).toBe(
      '{"issues":[{"path":["payload"],"code":"invalid_union"}]}',
    );
    expect(inspect(refusal)).toBe(`LegacyRefusal ${JSON.stringify(refusal)}`);
  });
});

describe('describeLegacyRefusal on a stock-zod fallback (addendum H)', () => {
  const VALUE = 'SENTINEL-041-value';
  const RECORD_NAME = 'SENTINEL-041-record';

  it('describes it exactly as the same refusal reached the ordinary way, and the generic one without a value', () => {
    const left = z
      .object({ a: z.string() })
      .strict()
      .transform((value) => value)
      .refine(() => false, 'never allowed');
    const fallbackSchema = z.object({
      tags: z.record(z.string(), z.intersection(left, z.object({ b: z.string() }))),
    });
    const ordinarySchema = z.object({
      tags: z.record(
        z.string(),
        z.object({ a: z.string(), b: z.string() }).refine(() => false, 'never allowed'),
      ),
    });
    const input = { tags: { [RECORD_NAME]: { a: VALUE, b: VALUE } } };
    // Run in zod 3's order the refusal is reconciled away (r3 F3): legacyParse keeps stock zod's.
    expect(
      fallbackSchema.safeParse(input, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never)
        .success,
    ).toBe(true);
    const fallback = legacyParse(fallbackSchema, input);
    const ordinary = legacyParse(ordinarySchema, input);
    if (fallback.success || ordinary.success) throw new Error('expected refusals');
    expect(describeLegacyRefusal(fallback.refusal)).toBe(describeLegacyRefusal(ordinary.refusal));
    expect(describeLegacyRefusal(fallback.refusal)).not.toContain(VALUE);

    // An error map that throws: neither refusal can be worded; the raw error stays inside.
    const generic = legacyParse(
      z.object({
        a: z.string().refine(() => false, {
          error: () => {
            throw new Error(VALUE);
          },
        }),
      }),
      { a: VALUE },
    );
    if (generic.success) throw new Error('expected a refusal');
    expect(generic.refusal.issues).toEqual([genericLegacyIssue()]);
    expect(describeLegacyRefusal(generic.refusal)).toBe('(root) custom');
  });
});
