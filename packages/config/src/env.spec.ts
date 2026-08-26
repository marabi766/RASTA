import { baseEnvSchema, databaseEnvSchema, loadEnv, EnvValidationError } from './env';

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
