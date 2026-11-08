import * as contracts from '@rasta/contracts';
import { documentEnvSchema } from './config/env';

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
  'documentEnvSchema m0 PORT=0.5': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_small', 'Number must be greater than or equal to 1'],
    [
      'DOCUMENT_CLAMAV_SOCKET_PATH',
      'custom',
      'The ClamAV driver needs an address: set DOCUMENT_CLAMAV_SOCKET_PATH (production) or DOCUMENT_CLAMAV_HOST (local development and CI only).',
    ],
  ],
  'documentEnvSchema m0 PORT=Infinity': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_big', 'Number must be less than or equal to 65535'],
    [
      'DOCUMENT_CLAMAV_SOCKET_PATH',
      'custom',
      'The ClamAV driver needs an address: set DOCUMENT_CLAMAV_SOCKET_PATH (production) or DOCUMENT_CLAMAV_HOST (local development and CI only).',
    ],
  ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'documentEnvSchema m0 PORT=0.5',
    documentEnvSchema,
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
      S3_ACCESS_KEY: 'Sample',
      S3_SECRET_KEY: 'Sample',
    },
  ],
  [
    'documentEnvSchema m0 PORT=Infinity',
    documentEnvSchema,
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
      S3_ACCESS_KEY: 'Sample',
      S3_SECRET_KEY: 'Sample',
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
