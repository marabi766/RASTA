import * as contracts from '@rasta/contracts';
import { searchSuppliersQuerySchema } from './supplier/dto';

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
  'searchSuppliersQuerySchema m1 limit=0.5': [
    ['limit', 'invalid_type', 'Expected integer, received float'],
    ['limit', 'too_small', 'Number must be greater than or equal to 1'],
    [
      'status',
      'custom',
      'qualifiedFor already implies an active supplier; a suspended supplier is never currently qualified, so the two filters cannot be combined',
    ],
  ],
  'searchSuppliersQuerySchema m1 limit=Infinity': [
    ['limit', 'invalid_type', 'Expected integer, received float'],
    ['limit', 'too_big', 'Number must be less than or equal to 200'],
    [
      'status',
      'custom',
      'qualifiedFor already implies an active supplier; a suspended supplier is never currently qualified, so the two filters cannot be combined',
    ],
  ],
  'searchSuppliersQuerySchema review r2: qualifiedFor already implies an active supplier; a suspended':
    [
      ['limit', 'invalid_type', 'Expected integer, received float'],
      ['limit', 'too_small', 'Number must be greater than or equal to 1'],
      [
        'status',
        'custom',
        'qualifiedFor already implies an active supplier; a suspended supplier is never currently qualified, so the two filters cannot be combined',
      ],
    ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'searchSuppliersQuerySchema m1 limit=0.5',
    searchSuppliersQuerySchema,
    {
      cursor: 'Sample',
      limit: 0.5,
      capability: 'WORKSHOP_SERVICE',
      qualifiedFor: 'WORKSHOP_SERVICE',
      status: 'SUSPENDED',
    },
  ],
  [
    'searchSuppliersQuerySchema m1 limit=Infinity',
    searchSuppliersQuerySchema,
    {
      cursor: 'Sample',
      limit: Number.POSITIVE_INFINITY,
      capability: 'WORKSHOP_SERVICE',
      qualifiedFor: 'WORKSHOP_SERVICE',
      status: 'SUSPENDED',
    },
  ],
  [
    'searchSuppliersQuerySchema review r2: qualifiedFor already implies an active supplier; a suspended',
    searchSuppliersQuerySchema,
    { limit: '0.5', qualifiedFor: 'GOODS_SUPPLY', status: 'SUSPENDED' },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
