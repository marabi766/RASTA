import { z } from 'zod';

import type { FuzzReport } from './__tests__/zod-differential';
import { releaseStockZod, runInBuild, type Build } from './__tests__/zod-stock-oracle';
import {
  describeLegacyRefusal,
  genericLegacyIssue,
  legacyParse,
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
