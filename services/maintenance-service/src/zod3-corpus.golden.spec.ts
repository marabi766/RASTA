import * as contracts from '@rasta/contracts';
import { createScheduleSchema, updateScheduleSchema } from './maintenance/dto';

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
  'createScheduleSchema m0 leadDays=0.5': [
    ['leadDays', 'invalid_type', 'Expected integer, received float'],
    [
      'intervalDays',
      'custom',
      'Set at least one of intervalDays, intervalHours or intervalKilometres; a schedule with no interval never comes due',
    ],
  ],
  'createScheduleSchema m0 leadDays=Infinity': [
    ['leadDays', 'invalid_type', 'Expected integer, received float'],
    ['leadDays', 'too_big', 'Number must be less than or equal to 365'],
    [
      'intervalDays',
      'custom',
      'Set at least one of intervalDays, intervalHours or intervalKilometres; a schedule with no interval never comes due',
    ],
  ],
  'updateScheduleSchema m0 intervalDays=0.5 (no refinement can fail with it)': [
    ['intervalDays', 'invalid_type', 'Expected integer, received float'],
    ['intervalDays', 'too_small', 'Number must be greater than or equal to 1'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'createScheduleSchema m0 leadDays=0.5',
    createScheduleSchema,
    { assetId: 'AST_01JB9V5Q6K8M2N4P7R3S5T7V9X', title: 'Sample', leadDays: 0.5 },
  ],
  [
    'createScheduleSchema m0 leadDays=Infinity',
    createScheduleSchema,
    {
      assetId: 'AST_01JB9V5Q6K8M2N4P7R3S5T7V9X',
      title: 'Sample',
      leadDays: Number.POSITIVE_INFINITY,
    },
  ],
  [
    'updateScheduleSchema m0 intervalDays=0.5 (no refinement can fail with it)',
    updateScheduleSchema,
    { intervalDays: 0.5 },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
