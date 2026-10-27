import * as contracts from '@rasta/contracts';
import { marketplaceEnvSchema } from './config/env';
import { updateOfferSchema } from './offer/dto';
import { createReturnSchema } from './returns/dto';

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
  'marketplaceEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_small', 'Number must be greater than or equal to 1'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
  ],
  'marketplaceEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_big', 'Number must be less than or equal to 65535'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'custom', 'URL must be a valid URL'],
  ],
  'createReturnSchema m0 dup lines + lines.0.quantity=0.5': [
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.1.orderLineId', 'custom', 'An order line may appear once in a return request'],
  ],
  'createReturnSchema m0 dup lines + lines.0.quantity=Infinity': [
    ['lines.0.quantity', 'invalid_type', 'Expected integer, received float'],
    ['lines.0.quantity', 'too_big', 'Number must be less than or equal to 1000000'],
    ['lines.1.orderLineId', 'custom', 'An order line may appear once in a return request'],
  ],
  'updateOfferSchema m0 availableQuantity=0.5 (no refinement can fail with it)': [
    ['availableQuantity', 'invalid_type', 'Expected integer, received float'],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'marketplaceEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=0.5',
    marketplaceEnvSchema,
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
    'marketplaceEnvSchema m0 same OTEL_EXPORTER_OTLP_ENDPOINT + PORT=Infinity',
    marketplaceEnvSchema,
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
    'createReturnSchema m0 dup lines + lines.0.quantity=0.5',
    createReturnSchema,
    {
      reason: 'AST-SAMPLE',
      lines: [
        { orderLineId: 'ORG-SAMPLE', quantity: 0.5 },
        { orderLineId: 'ORG-SAMPLE', quantity: 1 },
      ],
    },
  ],
  [
    'createReturnSchema m0 dup lines + lines.0.quantity=Infinity',
    createReturnSchema,
    {
      reason: 'AST-SAMPLE',
      lines: [
        { orderLineId: 'ORG-SAMPLE', quantity: Number.POSITIVE_INFINITY },
        { orderLineId: 'ORG-SAMPLE', quantity: 1 },
      ],
    },
  ],
  [
    'updateOfferSchema m0 availableQuantity=0.5 (no refinement can fail with it)',
    updateOfferSchema,
    { availableQuantity: 0.5 },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
