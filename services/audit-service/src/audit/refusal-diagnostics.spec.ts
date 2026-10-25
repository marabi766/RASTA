import { z } from 'zod';
import { LegacyContextError, legacyParse, type LegacyRefusal } from '@rasta/contracts';
import {
  DIAGNOSTIC_MAX_LENGTH,
  declaredFieldNames,
  describeErrorClass,
  describeEventType,
  describeIssues,
  parseOrRefuse,
  SchemaRefusedError,
  schemaRefusalOf,
} from './refusal-diagnostics';
import { ORGANIZATION_PROJECTION_FIELD_NAMES } from './organization-projection';

/** PR #378 r1 F3: what a refusal may say about a message. */

const SENTINEL_KEY = 'customer-SENTINEL@example.test';

const issuesOf = (schema: z.ZodTypeAny, value: unknown): LegacyRefusal => {
  const result = legacyParse(schema, value);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
};

/** A refusal whose issues a refinement writes as given. */
const refusalWith = (issues: { code: string; path: (string | number)[]; message: string }[]) =>
  issuesOf(
    z.unknown().superRefine((_value, ctx) => {
      for (const issue of issues) ctx.addIssue(issue as never);
    }),
    null,
  );

describe('describeEventType', () => {
  it('names a well-formed type and version', () => {
    expect(describeEventType({ eventName: 'ORGANIZATION_MOVED', eventVersion: 2 })).toBe(
      'ORGANIZATION_MOVED v2',
    );
  });

  it.each([
    [{ eventName: SENTINEL_KEY, eventVersion: 1 }, '(unnamed event) v1'],
    [{ eventName: 'OK_NAME', eventVersion: SENTINEL_KEY }, 'OK_NAME v?'],
    [{ eventName: 'OK_NAME', eventVersion: 1.5 }, 'OK_NAME v?'],
    [{ eventName: 'X'.repeat(200), eventVersion: 0 }, '(unnamed event) v?'],
    [SENTINEL_KEY, '(unnamed event) v?'],
    [null, '(unnamed event) v?'],
  ])('logs fixed placeholders for a malformed envelope (%#)', (envelope, expected) => {
    expect(describeEventType(envelope)).toBe(expected);
  });
});

describe('declaredFieldNames', () => {
  const schema = z
    .object({
      outer: z.object({ inner: z.string() }).optional(),
      list: z.array(z.object({ item: z.number() })),
      open: z.record(z.string(), z.object({ value: z.string() })),
    })
    .superRefine(() => undefined);

  it('collects every declared key at any depth, through wrappers and arrays', () => {
    expect([...declaredFieldNames(schema)].sort()).toEqual(
      ['inner', 'item', 'list', 'open', 'outer', 'value'].sort(),
    );
  });

  it('reads the organization projection schemas', () => {
    for (const field of ['organizationId', 'newStatus', 'affectedIds', 'parentId', 'newParentId']) {
      expect(ORGANIZATION_PROJECTION_FIELD_NAMES.has(field)).toBe(true);
    }
  });
});

describe('describeIssues', () => {
  const schema = z.object({
    status: z.string(),
    open: z.record(z.string(), z.object({ value: z.string() })),
  });
  const declared = declaredFieldNames(schema);

  it('prints declared paths and codes, never a Zod message or a value', () => {
    const text = describeIssues(
      issuesOf(schema, { status: SENTINEL_KEY.length, open: {} }),
      declared,
    );
    expect(text).toBe('status invalid_type');
  });

  it('withholds a path segment the schema does not declare, and counts it', () => {
    // A record's key is the producer's text: it appears in the issue path.
    const text = describeIssues(
      issuesOf(schema, { status: 'ok', open: { [SENTINEL_KEY]: { value: 1 } } }),
      declared,
    );
    expect(text).toBe('open.?.value invalid_type [1 undeclared path segment(s) withheld]');
    expect(text).not.toContain('SENTINEL');
  });

  it('keeps array indices, which are not producer text', () => {
    const list = z.object({ ids: z.array(z.string()) });
    expect(describeIssues(issuesOf(list, { ids: ['a', 2] }), declaredFieldNames(list))).toBe(
      'ids.1 invalid_type',
    );
  });

  it('bounds the number of issues and the length', () => {
    const list = z.object({ ids: z.array(z.string()) });
    const issues = issuesOf(list, { ids: Array.from({ length: 5_000 }, (_, i) => i) });
    const text = describeIssues(issues, declaredFieldNames(list));
    expect(text).toMatch(/, …\(5000 total\)$/);
    expect(text.length).toBeLessThanOrEqual(DIAGNOSTIC_MAX_LENGTH);

    const long = refusalWith(
      Array.from({ length: 10 }, () => ({
        code: 'custom',
        path: Array.from({ length: 30 }, () => 'status'),
        message: SENTINEL_KEY,
      })),
    );
    const bounded = describeIssues(long, declared);
    expect(bounded.length).toBe(DIAGNOSTIC_MAX_LENGTH);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('replaces a code that is not shaped like a Zod code', () => {
    const forged = refusalWith([{ code: SENTINEL_KEY, path: ['status'], message: '' }]);
    expect(describeIssues(forged, declared)).toBe('status unknown_code');
  });

  it('refuses a bare zod error or its issues: they carry no schema to translate against (r1 F1)', () => {
    const bare = schema.safeParse({ status: 1, open: {} }).error;
    expect(() => describeIssues(bare as never, declared)).toThrow(LegacyContextError);
    expect(() => describeIssues(bare?.issues as never, declared)).toThrow(LegacyContextError);
  });
});

describe('describeErrorClass, parseOrRefuse and schemaRefusalOf', () => {
  it('names a class, never a message', () => {
    expect(describeErrorClass(new SyntaxError(SENTINEL_KEY))).toBe('SyntaxError');
    const forged = new Error('x');
    forged.name = SENTINEL_KEY;
    expect(describeErrorClass(forged)).toBe('Error');
    expect(describeErrorClass(SENTINEL_KEY)).toBe('Error');
  });

  it('carries the refusal of the parse, and nothing else counts as one', () => {
    expect(parseOrRefuse(z.string(), 'ok')).toBe('ok');
    let thrown: unknown;
    try {
      parseOrRefuse(z.object({ status: z.string() }), { status: SENTINEL_KEY.length });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaRefusedError);
    expect(String((thrown as Error).message)).toBe('the payload does not match its schema');
    expect(schemaRefusalOf(thrown)?.issues.map((issue) => issue.code)).toEqual(['invalid_type']);
    // A bare ZodError has no schema behind it: not a refusal, so it is named by its class.
    expect(schemaRefusalOf(z.string().safeParse(1).error)).toBeNull();
    expect(schemaRefusalOf(new Error('x'))).toBeNull();
    expect(schemaRefusalOf(null)).toBeNull();
  });
});
