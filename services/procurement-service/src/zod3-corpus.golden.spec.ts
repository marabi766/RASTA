import * as contracts from '@rasta/contracts';
import { procurementEnvSchema } from './config/env';
import { PROCUREMENT_EVENT_SCHEMAS } from './events/events';
import { criterionSchema, issueRfqSchema, rfqViewSchema } from './rfq/dto';

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
  'procurementEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_small', 'Number must be greater than or equal to 1'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
  ],
  'procurementEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_big', 'Number must be less than or equal to 65535'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
  ],
  'PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED m0 settingVersion=0.5': [
    ['settingVersion', 'invalid_type', 'Expected integer, received float'],
    ['settingVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['', 'custom', 'previousVersion is the version before settingVersion, null before the first'],
  ],
  'PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED m0 settingVersion=Infinity': [
    ['settingVersion', 'invalid_type', 'Expected integer, received float'],
    ['', 'custom', 'previousVersion is the version before settingVersion, null before the first'],
  ],
  'criterionSchema m0 enum scoringMethod=PASS_FAIL + maxScore=0.5': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'too_small', 'Number must be greater than or equal to 1'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'criterionSchema m0 enum scoringMethod=PASS_FAIL + maxScore=Infinity': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'too_big', 'Number must be less than or equal to 1000000'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'issueRfqSchema m0 expectedVersion=0.5': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['expectedVersion', 'too_small', 'Number must be greater than or equal to 1'],
    ['criteria', 'custom', 'The weights must sum to exactly 10000 basis points'],
  ],
  'issueRfqSchema m0 expectedVersion=Infinity': [
    ['expectedVersion', 'invalid_type', 'Expected integer, received float'],
    ['criteria', 'custom', 'The weights must sum to exactly 10000 basis points'],
  ],
  'rfqViewSchema m0 enum criteria.0.scoringMethod=PASS_FAIL + criteria.0.maxScore=0.5': [
    ['criteria.0.maxScore', 'invalid_type', 'Expected integer, received float'],
    ['criteria.0.maxScore', 'too_small', 'Number must be greater than or equal to 1'],
    ['criteria.0.maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'rfqViewSchema m0 enum criteria.0.scoringMethod=PASS_FAIL + criteria.0.maxScore=Infinity': [
    ['criteria.0.maxScore', 'invalid_type', 'Expected integer, received float'],
    ['criteria.0.maxScore', 'too_big', 'Number must be less than or equal to 1000000'],
    ['criteria.0.maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
  'criterionSchema review r2: A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1': [
    ['maxScore', 'invalid_type', 'Expected integer, received float'],
    ['maxScore', 'custom', 'A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'procurementEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5',
    procurementEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: 0.5,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'Sample',
    },
  ],
  [
    'procurementEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity',
    procurementEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: Number.POSITIVE_INFINITY,
      DATABASE_URL: 'postgresql://one:two@localhost:5432/one',
      KAFKA_BROKERS: 'Sample',
      KAFKA_CLIENT_ID: 'ORG-SAMPLE',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'Sample',
    },
  ],
  [
    'PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED m0 settingVersion=0.5',
    PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED,
    {
      organizationId: 'ORG-SAMPLE',
      settingVersion: 0.5,
      previousVersion: 1,
      windowHours: 1,
      minQuantity: 1,
      shortfallPolicy: 'EXTEND',
      recordedBy: 'Sample',
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED m0 settingVersion=Infinity',
    PROCUREMENT_EVENT_SCHEMAS.AGGREGATION_SETTING_CHANGED,
    {
      organizationId: 'ORG-SAMPLE',
      settingVersion: Number.POSITIVE_INFINITY,
      previousVersion: 1,
      windowHours: 1,
      minQuantity: 1,
      shortfallPolicy: 'EXTEND',
      recordedBy: 'Sample',
      recordedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    'criterionSchema m0 enum scoringMethod=PASS_FAIL + maxScore=0.5',
    criterionSchema,
    { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'PASS_FAIL', maxScore: 0.5 },
  ],
  [
    'criterionSchema m0 enum scoringMethod=PASS_FAIL + maxScore=Infinity',
    criterionSchema,
    {
      code: 'Sample',
      label: 'Sample',
      weightBp: 1,
      scoringMethod: 'PASS_FAIL',
      maxScore: Number.POSITIVE_INFINITY,
    },
  ],
  [
    'issueRfqSchema m0 expectedVersion=0.5',
    issueRfqSchema,
    {
      expectedVersion: 0.5,
      procurementNature: 'FORMAL_TENDER',
      quotationClosingAt: '2026-10-01T00:00:00.000Z',
      criteria: [
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 1,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
      ],
      invitedSupplierOrganizationIds: ['ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X'],
    },
  ],
  [
    'issueRfqSchema m0 expectedVersion=Infinity',
    issueRfqSchema,
    {
      expectedVersion: Number.POSITIVE_INFINITY,
      procurementNature: 'FORMAL_TENDER',
      quotationClosingAt: '2026-10-01T00:00:00.000Z',
      criteria: [
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 1,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 1,
        },
      ],
      invitedSupplierOrganizationIds: ['ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X'],
    },
  ],
  [
    'rfqViewSchema m0 enum criteria.0.scoringMethod=PASS_FAIL + criteria.0.maxScore=0.5',
    rfqViewSchema,
    {
      id: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      aggregationId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      totalQuantity: 1,
      status: 'PUBLISHED',
      procurementNature: 'FORMAL_TENDER',
      quotationClosingAt: 'Sample',
      criteria: [
        { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'PASS_FAIL', maxScore: 0.5 },
      ],
      criteriaDigest: 'Sample',
      issuedAt: 'Sample',
      closedAt: 'Sample',
      cancelledAt: 'Sample',
      cancelReasonCode: 'Sample',
      version: 1,
    },
  ],
  [
    'rfqViewSchema m0 enum criteria.0.scoringMethod=PASS_FAIL + criteria.0.maxScore=Infinity',
    rfqViewSchema,
    {
      id: 'ORG-SAMPLE',
      organizationId: 'ORG-SAMPLE',
      aggregationId: 'ORG-SAMPLE',
      productId: 'ORG-SAMPLE',
      totalQuantity: 1,
      status: 'PUBLISHED',
      procurementNature: 'FORMAL_TENDER',
      quotationClosingAt: 'Sample',
      criteria: [
        {
          code: 'Sample',
          label: 'Sample',
          weightBp: 1,
          scoringMethod: 'PASS_FAIL',
          maxScore: Number.POSITIVE_INFINITY,
        },
      ],
      criteriaDigest: 'Sample',
      issuedAt: 'Sample',
      closedAt: 'Sample',
      cancelledAt: 'Sample',
      cancelReasonCode: 'Sample',
      version: 1,
    },
  ],
  [
    'criterionSchema review r2: A PASS_FAIL criterion is scored 0 or 1: maxScore must be 1',
    criterionSchema,
    { code: 'Sample', label: 'Sample', weightBp: 1, scoringMethod: 'PASS_FAIL', maxScore: 1.5 },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
