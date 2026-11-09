import { z } from 'zod';
import { EnvValidationError, baseEnvSchema, loadEnv } from './env';
import { envEnumProbes } from './env-probe';

/**
 * Differential goldens for config's adapters of a zod refusal (PR #444 r1
 * F1): the refusal `loadEnv` throws at boot and the codes `envEnumProbes`
 * reports. Each `ZOD3` value was recorded by running this file unchanged on
 * main `745d0434` (zod 3.25.76) (`~/worker2/session/t109/scripts/record.sh`).
 */

/** Zod 3 records, with deliberate FU-287 digit-parser diagnostic changes below. */
const EXPECTED: Record<string, unknown> = {
  'base nothing set':
    'Invalid environment configuration:\n  - SERVICE_NAME: Required\n  - PORT: Required',
  'base PORT 1e999':
    'Invalid environment configuration:\n  - PORT: Expected a whole number written as digits, such as "10"',
  'base PORT 0.5':
    'Invalid environment configuration:\n  - PORT: Expected a whole number written as digits, such as "10"',
  'base PORT abc':
    'Invalid environment configuration:\n  - PORT: Expected a whole number written as digits, such as "10"',
  'base NODE_ENV outside its enum': 'loaded',
  'base LOG_LEVEL empty':
    "Invalid environment configuration:\n  - LOG_LEVEL: Invalid enum value. Expected 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
  'base OTEL endpoint not a URL':
    'Invalid environment configuration:\n  - OTEL_EXPORTER_OTLP_ENDPOINT: URL must be a valid URL',
  'base SHUTDOWN_TIMEOUT_MS 999.5':
    'Invalid environment configuration:\n  - SHUTDOWN_TIMEOUT_MS: Expected a whole number written as digits, such as "10"',
  'service a one-value enum missing':
    'Invalid environment configuration:\n  - CURRENCY: Required\n  - TIER: Required',
  'service a one-value enum given another value':
    "Invalid environment configuration:\n  - CURRENCY: Invalid enum value. Expected 'IRR'\n  - TIER: Required",
  'service an enum missing': 'Invalid environment configuration:\n  - TIER: Required',
  'probe codes': [
    ['NODE_ENV', ['invalid_enum_value']],
    ['LOG_LEVEL', ['invalid_enum_value']],
  ],
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(EXPECTED[name]);
}

const BASE = { SERVICE_NAME: 'zod3-golden', PORT: '3000' };

function refusal(schema: z.ZodTypeAny, source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(schema, source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  return 'loaded';
}

describe('environment diagnostics retain legacy wording with strict digit parsing', () => {
  it.each([
    ['nothing set', {}],
    ['PORT 1e999', { ...BASE, PORT: '1e999' }],
    ['PORT 0.5', { ...BASE, PORT: '0.5' }],
    ['PORT abc', { ...BASE, PORT: 'abc' }],
    ['NODE_ENV outside its enum', { ...BASE, NODE_ENV: 'staging' }],
    ['LOG_LEVEL empty', { ...BASE, LOG_LEVEL: '' }],
    ['OTEL endpoint not a URL', { ...BASE, OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }],
    ['SHUTDOWN_TIMEOUT_MS 999.5', { ...BASE, SHUTDOWN_TIMEOUT_MS: '999.5' }],
  ])('baseEnvSchema: %s', (name, source) => {
    matchesZod3(`base ${name}`, refusal(baseEnvSchema, source as NodeJS.ProcessEnv));
  });

  it.each([
    ['a one-value enum missing', {}],
    ['a one-value enum given another value', { CURRENCY: 'USD' }],
    ['an enum missing', { CURRENCY: 'IRR' }],
  ])('a service schema: %s', (name, source) => {
    const schema = z.object({
      CURRENCY: z.enum(['IRR']),
      MODE: z.enum(['A', 'B']).optional(),
      TIER: z.enum(['X', 'Y']),
    });
    matchesZod3(`service ${name}`, refusal(schema, source as NodeJS.ProcessEnv));
  });

  it('envEnumProbes: the codes under each enum setting', () => {
    const probes = envEnumProbes(baseEnvSchema, (source) => loadEnv(baseEnvSchema, source), BASE, [
      'zod3-a',
      'zod3-b',
    ]);
    matchesZod3(
      'probe codes',
      probes.map((probe) => [probe.name, probe.codes]),
    );
  });
});
