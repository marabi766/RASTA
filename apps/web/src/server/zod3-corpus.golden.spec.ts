import * as contracts from '@rasta/contracts';
import { storedRecordSchema } from './unresolved-request-store';

/**
 * The PR #444 r3 differential corpus (Codex PR-444 r2 F1) for this workspace's
 * schema roots. Each case fails an integer check (a fraction, or ±Infinity
 * where text becomes a number) together with an enclosing refinement, or is a
 * reviewer's or a sibling class's reproduction; zod 3 reported both, zod 4
 * stopped at the integer. The roots are the exported schemas with an
 * integer under a refinement (`~/worker6/session/039/corpus`: `sweep.cjs`
 * inventory, `mkgolden.cjs`).
 *
 * Each `ZOD3` value was recorded by running this file unchanged on main
 * `5c88ae21` (zod 3.25.76), where `legacyParse` does not exist and
 * `outcome` reads zod 3's own issues (`~/worker2/session/t109/scripts/record.sh`);
 * never written by a test run here.
 */

type Issue = { path: readonly PropertyKey[]; code: string; message: string };
type LegacyParse = (schema: unknown, input: unknown) => { refusal?: { issues: readonly Issue[] } };

/** `[path, code, message]` per issue, in order, or `accepted`. */
function outcome(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const legacyParse = (contracts as unknown as { legacyParse?: LegacyParse }).legacyParse;
  const issues = legacyParse
    ? legacyParse(schema, input).refusal?.issues
    : (schema.safeParse(input) as { error?: { issues: readonly Issue[] } }).error?.issues;
  if (issues === undefined) return 'accepted';
  return issues.map((issue) => [issue.path.map(String).join('.'), issue.code, issue.message]);
}

/** Recorded under zod 3 on main 5c88ae21; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'storedRecordSchema m0 enum state=UNRESOLVED + deadline=0.5': [
    ['login', 'invalid_string', 'Invalid'],
    ['deadline', 'invalid_type', 'Expected integer, received float'],
    ['id', 'invalid_string', 'Invalid'],
    ['attemptId', 'invalid_string', 'Invalid'],
    ['bind', 'invalid_string', 'Invalid'],
    ['', 'custom', 'Invalid input'],
  ],
  'storedRecordSchema m0 enum state=UNRESOLVED + deadline=Infinity': [
    ['login', 'invalid_string', 'Invalid'],
    ['deadline', 'invalid_type', 'Expected integer, received float'],
    ['deadline', 'too_big', 'Number must be less than or equal to 9007199254740991'],
    ['id', 'invalid_string', 'Invalid'],
    ['attemptId', 'invalid_string', 'Invalid'],
    ['bind', 'invalid_string', 'Invalid'],
    ['', 'custom', 'Invalid input'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'storedRecordSchema m0 enum state=UNRESOLVED + deadline=0.5',
    storedRecordSchema,
    {
      v: 2,
      purpose: 'foo',
      target: 'Sample',
      org: 'Sample',
      login: 'x',
      deadline: 0.5,
      id: 'x',
      attemptId: 'x',
      key: 'Sample',
      digest: 'Sample',
      issuedAt: 1,
      ref: 'Sample',
      state: 'UNRESOLVED',
      wasUnresolved: false,
      createdAt: 1,
      reservedAt: 1,
      bind: 'x',
    },
  ],
  [
    'storedRecordSchema m0 enum state=UNRESOLVED + deadline=Infinity',
    storedRecordSchema,
    {
      v: 2,
      purpose: 'foo',
      target: 'Sample',
      org: 'Sample',
      login: 'x',
      deadline: Number.POSITIVE_INFINITY,
      id: 'x',
      attemptId: 'x',
      key: 'Sample',
      digest: 'Sample',
      issuedAt: 1,
      ref: 'Sample',
      state: 'UNRESOLVED',
      wasUnresolved: false,
      createdAt: 1,
      reservedAt: 1,
      bind: 'x',
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
