import * as contracts from '@rasta/contracts';
import { gatewayEnvSchema } from './config/env';

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
  'gatewayEnvSchema m0 PORT=0.5': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_small', 'Number must be greater than or equal to 1'],
    ['REDIS_URL', 'custom', 'Redis URL must be a valid URL'],
  ],
  'gatewayEnvSchema m0 PORT=Infinity': [
    ['PORT', 'invalid_type', 'Expected integer, received float'],
    ['PORT', 'too_big', 'Number must be less than or equal to 65535'],
    ['REDIS_URL', 'custom', 'Redis URL must be a valid URL'],
  ],
  'gatewayEnvSchema sibling: an issue added inside a transform (booleanEnv) and a cross-field refinement':
    [
      ['OTEL_TRACES_ENABLED', 'custom', 'Expected a boolean such as "true" or "false"'],
      ['REDIS_URL', 'custom', 'Redis URL must be a valid URL'],
      ['GATEWAY_UPSTREAM_TIMEOUT_MS', 'invalid_type', 'Expected integer, received float'],
      ['GATEWAY_RATE_LIMIT_FAIL_OPEN', 'custom', 'Expected a boolean such as "true" or "false"'],
      [
        'GATEWAY_TRUSTED_PROXIES',
        'custom',
        'names an entry that is not an IP address, a CIDR range of /1 or narrower, or one of loopback, linklocal, uniquelocal. Trusting every hop, a hop count or a /0 range is refused: each believes a client-written header. Name proxy peers only.',
      ],
      ['GATEWAY_TENDER_OPEN_TIMEOUT_MS', 'custom', 'must be at least GATEWAY_UPSTREAM_TIMEOUT_MS'],
    ],
};

const CASES: [string, { safeParse(input: unknown): unknown }, unknown][] = [
  [
    'gatewayEnvSchema m0 PORT=0.5',
    gatewayEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: 0.5,
      REDIS_URL: 'x',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      IDENTITY_SERVICE_URL: 'https://example.test',
      ORGANIZATION_SERVICE_URL: 'https://example.test',
      ASSET_SERVICE_URL: 'https://example.test',
      FLEET_SERVICE_URL: 'https://example.test',
      MAINTENANCE_SERVICE_URL: 'https://example.test',
      MARKETPLACE_SERVICE_URL: 'https://example.test',
      PROCUREMENT_SERVICE_URL: 'https://example.test',
      SUPPLIER_SERVICE_URL: 'https://example.test',
      INVENTORY_SERVICE_URL: 'https://example.test',
      CONSTRUCTION_SERVICE_URL: 'https://example.test',
      CONTRACT_SERVICE_URL: 'https://example.test',
      ECONOMIC_SERVICE_URL: 'https://example.test',
      NOTIFICATION_SERVICE_URL: 'https://example.test',
      DOCUMENT_SERVICE_URL: 'https://example.test',
      AUDIT_SERVICE_URL: 'https://example.test',
      ANALYTICS_SERVICE_URL: 'https://example.test',
    },
  ],
  [
    'gatewayEnvSchema m0 PORT=Infinity',
    gatewayEnvSchema,
    {
      SERVICE_NAME: 'Sample',
      PORT: Number.POSITIVE_INFINITY,
      REDIS_URL: 'x',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      IDENTITY_SERVICE_URL: 'https://example.test',
      ORGANIZATION_SERVICE_URL: 'https://example.test',
      ASSET_SERVICE_URL: 'https://example.test',
      FLEET_SERVICE_URL: 'https://example.test',
      MAINTENANCE_SERVICE_URL: 'https://example.test',
      MARKETPLACE_SERVICE_URL: 'https://example.test',
      PROCUREMENT_SERVICE_URL: 'https://example.test',
      SUPPLIER_SERVICE_URL: 'https://example.test',
      INVENTORY_SERVICE_URL: 'https://example.test',
      CONSTRUCTION_SERVICE_URL: 'https://example.test',
      CONTRACT_SERVICE_URL: 'https://example.test',
      ECONOMIC_SERVICE_URL: 'https://example.test',
      NOTIFICATION_SERVICE_URL: 'https://example.test',
      DOCUMENT_SERVICE_URL: 'https://example.test',
      AUDIT_SERVICE_URL: 'https://example.test',
      ANALYTICS_SERVICE_URL: 'https://example.test',
    },
  ],
  [
    'gatewayEnvSchema sibling: an issue added inside a transform (booleanEnv) and a cross-field refinement',
    gatewayEnvSchema,
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      SERVICE_NAME: 'Sample',
      SERVICE_VERSION: 'Sample',
      PORT: 1,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://example.test',
      OTEL_TRACES_ENABLED: 'Sample',
      OTEL_SERVICE_NAMESPACE: 'Sample',
      SHUTDOWN_TIMEOUT_MS: 1000,
      REDIS_URL: 'x',
      REDIS_KEY_PREFIX: 'Sample',
      OIDC_ISSUER_URL: 'https://example.test',
      OIDC_JWKS_URI: 'https://example.test',
      OIDC_AUDIENCE: 'ORG-SAMPLE',
      INTERNAL_TOKEN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      INTERNAL_TOKEN_ISSUER: 'Sample',
      INTERNAL_TOKEN_TTL_SECONDS: 30,
      IDENTITY_SERVICE_URL: 'https://example.test',
      ORGANIZATION_SERVICE_URL: 'https://example.test',
      ASSET_SERVICE_URL: 'https://example.test',
      FLEET_SERVICE_URL: 'https://example.test',
      MAINTENANCE_SERVICE_URL: 'https://example.test',
      MARKETPLACE_SERVICE_URL: 'https://example.test',
      PROCUREMENT_SERVICE_URL: 'https://example.test',
      SUPPLIER_SERVICE_URL: 'https://example.test',
      INVENTORY_SERVICE_URL: 'https://example.test',
      CONSTRUCTION_SERVICE_URL: 'https://example.test',
      CONTRACT_SERVICE_URL: 'https://example.test',
      ECONOMIC_SERVICE_URL: 'https://example.test',
      NOTIFICATION_SERVICE_URL: 'https://example.test',
      DOCUMENT_SERVICE_URL: 'https://example.test',
      AUDIT_SERVICE_URL: 'https://example.test',
      ANALYTICS_SERVICE_URL: 'https://example.test',
      GATEWAY_CORS_ORIGINS: 'Sample',
      GATEWAY_RATE_LIMIT_MAX: 1,
      GATEWAY_RATE_LIMIT_WINDOW_MS: 1000,
      GATEWAY_TENANT_RATE_LIMIT_MAX: 1,
      GATEWAY_ANON_RATE_LIMIT_MAX: 1,
      GATEWAY_UPSTREAM_TIMEOUT_MS: Number.POSITIVE_INFINITY,
      GATEWAY_TENDER_OPEN_TIMEOUT_MS: 5000,
      GATEWAY_CIRCUIT_FAILURE_THRESHOLD: 1,
      GATEWAY_CIRCUIT_RESET_MS: 1000,
      GATEWAY_RATE_LIMIT_FAIL_OPEN: 'Sample',
      GATEWAY_TRUSTED_PROXIES: 'Sample',
    },
  ],
];

describe('zod 3 diagnostics: an integer refusal with its enclosing refinements (PR #444 r3)', () => {
  it.each(CASES)('%s', (name, schema, input) => {
    const observed = outcome(schema, input);
    expect(observed).toEqual(ZOD3[name]);
  });
});
