/**
 * @jest-environment node
 */
import { z } from 'zod';
import { isSchemaAuthored, LegacyContextError, legacyParse } from '@rasta/contracts';

import { firstIssuePerField, formIssueMessage, GENERIC_FIELD_MESSAGE } from '@/lib/form-issues';

import { KNOWN_PARSERS, resolveParsers } from '@/test/entry-points';

/**
 * Every local form parser of the portal, with hostile input in every field:
 * whatever a person would be shown for a failed field is Persian, fixed text —
 * never the input, Persian-prefixed or not, and never an invisible control.
 * The parsers are found by their parse calls (`test/entry-points.ts`), private
 * and function-local schemas included; one the sweep cannot drive needs an
 * adapter or a reasoned exclusion there (Codex PR-439 r1 F1, F4).
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const RESOLVED = resolveParsers();

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) return current.shape as Record<string, z.ZodTypeAny>;
    // A refinement is a check on the object itself; a transform or preprocess is a pipe.
    if (current instanceof z.ZodPipe)
      current = (current.in instanceof z.ZodTransform ? current.out : current.in) as z.ZodType;
    else return null;
  }
  return null;
}

const MARK = 'typed-input-marker';
const MARK_FA = 'نشانگرورودی';
const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
  ['empty', ''],
  ['very long text', 'ب'.repeat(5000)],
  ['400 digits', '9'.repeat(400)],
  ['a bidi control', 'ab\u202ecd'],
  ['a marked value', MARK],
  ['Persian marked input', `۱۲${MARK_FA}`],
  ['a marked value with a bidi control', `${MARK}\u202e`],
  ['Persian input with digits and a bidi control', `۱۲${MARK_FA}\u202e۳`],
  ['a decimal amount', '1.5'],
  ['a negative number', '-1'],
  ['an exponent', '1e999'],
  ['not a number', 'NaN'],
  ['an array holding an empty string', ['']],
  ['a long array', Array.from({ length: 500 }, () => 'x')],
  ['null', null],
  ['a number', 12],
  ['an object', { a: 1 }],
];
const HOSTILE_TEXT = HOSTILE.flatMap(([, value]) => (typeof value === 'string' ? [value] : []));
// Directional and other invisible controls; ZWNJ is Persian spelling.
const INVISIBLE = /(?!\u200c)\p{Cf}|\p{Cc}/u;

function expectShowable(message: string): void {
  expect(message).toMatch(/\p{Script=Arabic}/u);
  // A Latin word may sit inside a Persian sentence (a brand, a unit);
  // an all-English sentence may not.
  expect(message).not.toMatch(/^\p{ASCII}+$/u);
  expect(message).not.toMatch(/must contain|Expected|Invalid|Required|received/i);
  expect(message).not.toContain('9'.repeat(10));
  // Never the input: not the marker, Persian-prefixed or not, nor a control.
  expect(message).not.toContain(MARK);
  expect(message).not.toContain(MARK_FA);
  expect(message).not.toMatch(INVISIBLE);
}

describe('every local form parser answers in Persian, never with the input', () => {
  it('accounts for every parse call: swept, adapted or excluded with a reason (F4)', () => {
    expect(RESOLVED.unaccounted).toEqual([]);
    expect(RESOLVED.stale).toEqual([]);
    expect(RESOLVED.discovered).toEqual(expect.arrayContaining([...KNOWN_PARSERS]));
    expect(RESOLVED.schemas.length).toBeGreaterThanOrEqual(30);
  });

  it('finds the parse calls inside the private and function-local schemas too', () => {
    expect(RESOLVED.discovered).toEqual(
      expect.arrayContaining([
        'lib/project-commands:reasonSchema',
        'lib/project-commands:grantSchema',
        'lib/project-commands:rejectSchema',
        'server/asset-commands:schema',
      ]),
    );
  });

  it('sweeps the schemas a helper parses through its callers (supplier parseWith)', () => {
    const swept = RESOLVED.schemas.map(([name]) => name);
    expect(swept.filter((name) => name.startsWith('lib/supplier-commands.'))).toHaveLength(6);
  });

  it.each(RESOLVED.schemas)('%s: whatever fails is shown in Persian', (_name, schema) => {
    const shape = shapeOf(schema);
    expect(shape).not.toBeNull();
    const fields = Object.keys(shape!);

    let failures = 0;
    for (const [, hostile] of HOSTILE) {
      const result = legacyParse(
        schema,
        Object.fromEntries(fields.map((field) => [field, hostile])),
      );
      if (result.success) continue;
      for (const message of Object.values(firstIssuePerField(result.refusal, fields))) {
        failures += 1;
        expectShowable(message!);
      }
      // A Persian sentence the schema's author wrote is shown only if declared
      // (formMessage); one that is not is a sentence nobody vouched for.
      for (const issue of result.refusal.issues) {
        if (isSchemaAuthored(issue) && /\p{sc=Arab}/u.test(issue.message)) {
          expect(formIssueMessage(issue)).toBe(issue.message);
        }
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it.each(RESOLVED.adapters)(
    '%s (adapted): whatever fails is shown in Persian',
    (_key, adapter) => {
      let failures = 0;
      for (const hostile of HOSTILE_TEXT) {
        for (const message of adapter(hostile)) {
          failures += 1;
          expectShowable(message);
        }
      }
      expect(failures).toBeGreaterThan(0);
    },
  );

  it('answers one generic Persian sentence for an issue nobody foresaw', () => {
    const unknown = legacyParse(
      z.object({ name: z.string() }).superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'Something nobody foresaw' });
      }),
      { name: 'x' },
    );
    expect(unknown.refusal && firstIssuePerField(unknown.refusal, ['name'])).toEqual({
      name: GENERIC_FIELD_MESSAGE,
    });
  });

  it('refuses a bare zod error: without the parse that raised it, no sentence is guessed (r1 F1)', () => {
    const bare = z.object({ name: z.string() }).safeParse({}).error;
    expect(() => firstIssuePerField(bare as never, ['name'])).toThrow(LegacyContextError);
  });
});
