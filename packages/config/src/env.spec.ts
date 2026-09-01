import {
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
  EnvValidationError,
} from './env';

describe('loadEnv', () => {
  const validBase = {
    SERVICE_NAME: 'asset-service',
    PORT: '3103',
  };

  it('parses and coerces a valid environment', () => {
    const env = loadEnv(baseEnvSchema, validBase as NodeJS.ProcessEnv);

    expect(env.SERVICE_NAME).toBe('asset-service');
    expect(env.PORT).toBe(3103); // coerced from string
    expect(env.NODE_ENV).toBe('development'); // default applied
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing one missing variable per restart is a miserable way to configure
    // seventeen services, so the error must be exhaustive.
    expect.assertions(3);
    try {
      loadEnv(baseEnvSchema, { PORT: 'not-a-number' } as NodeJS.ProcessEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['SERVICE_NAME', 'PORT']));
    }
  });

  it('rejects a port outside the valid range', () => {
    expect(() =>
      loadEnv(baseEnvSchema, { ...validBase, PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV rather than falling back silently', () => {
    expect(() =>
      loadEnv(baseEnvSchema, { ...validBase, NODE_ENV: 'staging-2' } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it.each([
    ['localhost:5432', 'no protocol - the URL parser reads "localhost:" as a scheme'],
    ['http://db:5432/rasta', 'wrong protocol'],
    ['postgresql://', 'no host'],
    ['not a url at all', 'unparseable'],
  ])('rejects DATABASE_URL %p (%s)', (value) => {
    expect(() => loadEnv(databaseEnvSchema, { DATABASE_URL: value } as NodeJS.ProcessEnv)).toThrow(
      EnvValidationError,
    );
  });

  it.each([
    'postgresql://user:pass@localhost:5432/rasta_asset?schema=public',
    'postgres://user:pass@db.internal:5432/rasta_asset',
  ])('accepts DATABASE_URL %p', (value) => {
    expect(
      loadEnv(databaseEnvSchema, { DATABASE_URL: value } as NodeJS.ProcessEnv).DATABASE_URL,
    ).toBe(value);
  });

  it('applies pool defaults when not specified', () => {
    const env = loadEnv(databaseEnvSchema, {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    } as NodeJS.ProcessEnv);

    expect(env.DATABASE_POOL_SIZE).toBe(10);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
  });
});

/**
 * The two boolean flags the shared schemas own (D-020).
 *
 * Both read through `booleanEnv`. They used `z.coerce.boolean()`, under which
 * every non-empty string is `true` — so an operator who wrote
 * `OTEL_TRACES_ENABLED=false` kept exporting spans, and one who wrote
 * `KAFKA_SCHEMA_STRICT=false` to ship past a schema mismatch stayed strict.
 * Neither flag could be turned off, and nothing said so.
 *
 * These assertions fail against the coercion: that is what makes them a
 * regression test rather than a description.
 */
describe('boolean flags in the shared schemas', () => {
  const base = { SERVICE_NAME: 'asset-service', PORT: '3103' } as NodeJS.ProcessEnv;
  const kafka = { KAFKA_BROKERS: 'localhost:9092', KAFKA_CLIENT_ID: 'asset' } as NodeJS.ProcessEnv;

  describe('OTEL_TRACES_ENABLED', () => {
    const load = (value?: string) =>
      loadEnv(baseEnvSchema, {
        ...base,
        ...(value === undefined ? {} : { OTEL_TRACES_ENABLED: value }),
      });

    it('is true when absent — tracing is opt-out, so an unconfigured service stays visible', () => {
      expect(load().OTEL_TRACES_ENABLED).toBe(true);
    });

    it('reads "true" as true', () => {
      expect(load('true').OTEL_TRACES_ENABLED).toBe(true);
    });

    it('reads "false" as false', () => {
      expect(load('false').OTEL_TRACES_ENABLED).toBe(false);
    });

    it.each(['FALSE', '0', 'no', 'off', ' false '])('reads %p as false', (value) => {
      expect(load(value).OTEL_TRACES_ENABLED).toBe(false);
    });

    it.each(['maybe', 'enabled', '2'])('refuses %p rather than guessing', (value) => {
      expect(() => load(value)).toThrow(EnvValidationError);
    });
  });

  describe('KAFKA_SCHEMA_STRICT', () => {
    const load = (value?: string) =>
      loadEnv(kafkaEnvSchema, {
        ...kafka,
        ...(value === undefined ? {} : { KAFKA_SCHEMA_STRICT: value }),
      });

    it('is true when absent — an unvalidated event contract is not a contract', () => {
      expect(load().KAFKA_SCHEMA_STRICT).toBe(true);
    });

    it('reads "true" as true', () => {
      expect(load('true').KAFKA_SCHEMA_STRICT).toBe(true);
    });

    it('reads "false" as false', () => {
      expect(load('false').KAFKA_SCHEMA_STRICT).toBe(false);
    });

    it.each(['FALSE', '0', 'no', 'off'])('reads %p as false', (value) => {
      expect(load(value).KAFKA_SCHEMA_STRICT).toBe(false);
    });

    it.each(['maybe', 'strict', '2'])('refuses %p rather than guessing', (value) => {
      expect(() => load(value)).toThrow(EnvValidationError);
    });
  });
});
