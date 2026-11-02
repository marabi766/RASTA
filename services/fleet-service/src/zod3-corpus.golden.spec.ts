import * as contracts from '@rasta/contracts';
import { assetTransferredSchema, insuranceRecordedSchema } from './fleet/events';

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
  'assetTransferredSchema m0 ownershipGeneration=0.5': [
    ['ownershipGeneration', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'a transfer moves the asset to another organization'],
  ],
  'assetTransferredSchema m0 ownershipGeneration=Infinity': [
    ['ownershipGeneration', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'a transfer moves the asset to another organization'],
  ],
  'insuranceRecordedSchema m0 ownershipGeneration=0.5': [
    ['ownershipGeneration', 'invalid_type', 'Expected integer, received float'],
    ['validTo', 'custom', 'validTo must be an instant after validFrom'],
  ],
  'insuranceRecordedSchema m0 ownershipGeneration=Infinity': [
    ['ownershipGeneration', 'invalid_type', 'Expected integer, received float'],
    ['validTo', 'custom', 'validTo must be an instant after validFrom'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'assetTransferredSchema m0 ownershipGeneration=0.5',
    assetTransferredSchema,
    {
      assetId: 'ORG-SAMPLE',
      fromOrganizationId: 'ORG-SAMPLE',
      toOrganizationId: 'ORG-SAMPLE',
      transferredAt: '2026-10-01T00:00:00.000Z',
      ownershipGeneration: 0.5,
    },
  ],
  [
    'assetTransferredSchema m0 ownershipGeneration=Infinity',
    assetTransferredSchema,
    {
      assetId: 'ORG-SAMPLE',
      fromOrganizationId: 'ORG-SAMPLE',
      toOrganizationId: 'ORG-SAMPLE',
      transferredAt: '2026-10-01T00:00:00.000Z',
      ownershipGeneration: Number.POSITIVE_INFINITY,
    },
  ],
  [
    'insuranceRecordedSchema m0 ownershipGeneration=0.5',
    insuranceRecordedSchema,
    {
      assetId: 'ORG-SAMPLE',
      policyId: 'ORG-SAMPLE',
      coverage: 'Sample',
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-10-01T00:00:00.000Z',
      ownershipGeneration: 0.5,
    },
  ],
  [
    'insuranceRecordedSchema m0 ownershipGeneration=Infinity',
    insuranceRecordedSchema,
    {
      assetId: 'ORG-SAMPLE',
      policyId: 'ORG-SAMPLE',
      coverage: 'Sample',
      validFrom: '2026-10-01T00:00:00.000Z',
      validTo: '2026-10-01T00:00:00.000Z',
      ownershipGeneration: Number.POSITIVE_INFINITY,
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
