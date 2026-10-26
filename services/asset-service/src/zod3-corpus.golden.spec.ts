import * as contracts from '@rasta/contracts';
import {
  createAssetSchema,
  createPolicySchema,
  submitClaimSchema,
  updateAssetSchema,
} from './asset/dto';

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
  'updateAssetSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'At least one field must be provided'],
  ],
  'updateAssetSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'At least one field must be provided'],
  ],
  'submitClaimSchema sibling: a union refusal (seed-or-ULID id) and an object refinement': [
    ['policyId', 'custom', 'Expected an identifier of the form INS_<ULID>'],
    ['incidentAt', 'invalid_string', 'Invalid datetime'],
    ['incidentAt', 'custom', 'incidentAt cannot be in the future'],
  ],
  'createPolicySchema sibling: a value refused before its transform: no enclosing refinement': [
    ['insurerName', 'too_big', 'String must contain at most 200 character(s)'],
  ],
  'createAssetSchema sibling: a record given null': [
    ['specifications', 'invalid_type', 'Expected object, received null'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  ['updateAssetSchema m0 expectedVersion=0.5', updateAssetSchema, { expectedVersion: 0.5 }],
  [
    'updateAssetSchema m0 expectedVersion=Infinity',
    updateAssetSchema,
    { expectedVersion: Number.POSITIVE_INFINITY },
  ],
  [
    'submitClaimSchema sibling: a union refusal (seed-or-ULID id) and an object refinement',
    submitClaimSchema,
    { policyId: 'x', description: 'AST-SAMPLE', incidentAt: 'Sample' },
  ],
  [
    'createPolicySchema sibling: a value refused before its transform: no enclosing refinement',
    createPolicySchema,
    {
      policyNumber: 'Sample',
      insurerName:
        'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      coverage: 'THIRD_PARTY',
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'createAssetSchema sibling: a record given null',
    createAssetSchema,
    { name: 'Sample', type: 'GRADER', specifications: null },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
