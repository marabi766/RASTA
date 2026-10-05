import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  kafkaPasswordVariable,
  kafkaPlaintextAllowed,
  kafkaSaslConfigured,
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
  ])('accepts DATABASE_URL %p, and opens its sessions in UTC', (value) => {
    expect(
      loadEnv(databaseEnvSchema, { DATABASE_URL: value } as NodeJS.ProcessEnv).DATABASE_URL,
    ).toBe(`${value}${value.includes('?') ? '&' : '?'}options=-c%20TimeZone%3DUTC`);
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
  /**
   * ADR-050 picks these bounds for stated reasons, and the reasons only hold
   * at the bounds. Pinned here so a later "just lower it for a test" changes
   * a failing assertion rather than a durability guarantee silently.
   */
  describe('outbox durable claim (ADR-050)', () => {
    const load = (overrides: Record<string, string> = {}) =>
      loadEnv(kafkaEnvSchema, { ...kafka, ...overrides } as NodeJS.ProcessEnv);

    it('defaults to the values the ADR chose', () => {
      const env = load();

      expect(env.OUTBOX_CLAIM_LEASE_SECONDS).toBe(60);
      expect(env.OUTBOX_CLAIM_BACKOFF_SECONDS).toBe(5);
      expect(env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS).toBe(3600);
      expect(env.OUTBOX_SHUTDOWN_GRACE_SECONDS).toBe(20);
    });

    it('accepts a 20-second lease, the lowest the renewal schedule tolerates', () => {
      expect(load({ OUTBOX_CLAIM_LEASE_SECONDS: '20' }).OUTBOX_CLAIM_LEASE_SECONDS).toBe(20);
    });

    it.each(['19', '10', '0', '-1'])(
      'refuses a %p-second lease: below 20 the interval drops under five seconds and the ' +
        'last renewal lands on the expiry instant, leaving no tolerance at all',
      (value) => {
        expect(() => load({ OUTBOX_CLAIM_LEASE_SECONDS: value })).toThrow(EnvValidationError);
      },
    );

    it('refuses a lease above an hour', () => {
      expect(() => load({ OUTBOX_CLAIM_LEASE_SECONDS: '3601' })).toThrow(EnvValidationError);
    });

    it('refuses a zero backoff base, which would retry a poisoned row without pause', () => {
      expect(() => load({ OUTBOX_CLAIM_BACKOFF_SECONDS: '0' })).toThrow(EnvValidationError);
    });

    it('refuses a backoff ceiling above a day', () => {
      expect(() => load({ OUTBOX_CLAIM_BACKOFF_MAX_SECONDS: '86401' })).toThrow(EnvValidationError);
    });

    it('allows a zero shutdown grace — abandon immediately is a valid choice', () => {
      expect(load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '0' }).OUTBOX_SHUTDOWN_GRACE_SECONDS).toBe(0);
    });

    it('refuses a shutdown grace above five minutes, so a pod cannot hang in Terminating', () => {
      expect(() => load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '301' })).toThrow(EnvValidationError);
    });

    it.each(['abc', '1.5', ''])('refuses %p as a lease rather than coercing it', (value) => {
      expect(() => load({ OUTBOX_CLAIM_LEASE_SECONDS: value })).toThrow(EnvValidationError);
    });
  });
});

/**
 * RUN-006: the broker credential. Read from the environment only; whether a
 * service may run without one is decided by `kafkaConnection` (nest-common),
 * which refuses PLAINTEXT unless `kafkaPlaintextAllowed` (below).
 */
describe('SHUTDOWN_TIMEOUT_MS', () => {
  const base = { SERVICE_NAME: 'asset-service', PORT: '3103' } as NodeJS.ProcessEnv;
  const load = (value?: string) =>
    loadEnv(baseEnvSchema, value === undefined ? base : { ...base, SHUTDOWN_TIMEOUT_MS: value });

  it('defaults to 25 s, under the 30 s Kubernetes grace period', () => {
    expect(load().SHUTDOWN_TIMEOUT_MS).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(25_000);
  });

  it('reads an explicit value', () => {
    expect(load('10000').SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it.each(['0', '999', '120001', '-1', '2500.5', 'soon'])('refuses %p', (value) => {
    expect(() => load(value)).toThrow(EnvValidationError);
  });
});

describe('Kafka SASL credential', () => {
  const kafkaService = baseEnvSchema.merge(kafkaEnvSchema);
  const source = {
    SERVICE_NAME: 'fleet-service',
    PORT: '3104',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'fleet-service',
  } as NodeJS.ProcessEnv;
  const load = (extra: Record<string, string> = {}) =>
    loadEnv(kafkaService, { ...source, ...extra } as NodeJS.ProcessEnv);

  it('is absent by default: PLAINTEXT, and no TLS', () => {
    const env = load();
    expect(env.KAFKA_SASL_USERNAME).toBeUndefined();
    expect(env.KAFKA_SASL_PASSWORD).toBeUndefined();
    expect(env.KAFKA_SASL_MECHANISM).toBe('scram-sha-512');
    expect(env.KAFKA_SSL).toBe(false);
    expect(kafkaSaslConfigured(env)).toBe(false);
  });

  it("reads the service's own password from the repository .env, as the service's principal", () => {
    const env = load({
      KAFKA_SASL_PASSWORD_FLEET: 'fleet-secret',
      KAFKA_SASL_PASSWORD_ASSET: 'asset-secret',
    });
    expect(env.KAFKA_SASL_USERNAME).toBe('fleet-service');
    expect(env.KAFKA_SASL_PASSWORD).toBe('fleet-secret');
    expect(kafkaSaslConfigured(env)).toBe(true);
  });

  it('prefers an explicit KAFKA_SASL_PASSWORD and username, as a container sets them', () => {
    const env = load({
      KAFKA_SASL_PASSWORD: 'own',
      KAFKA_SASL_USERNAME: 'fleet-service',
      KAFKA_SASL_PASSWORD_FLEET: 'shared',
    });
    expect(env.KAFKA_SASL_PASSWORD).toBe('own');
  });

  it('treats an empty placeholder as unset', () => {
    const env = load({
      KAFKA_SASL_PASSWORD: '',
      KAFKA_SASL_PASSWORD_FLEET: '',
      KAFKA_SASL_USERNAME: '',
    });
    expect(kafkaSaslConfigured(env)).toBe(false);
    expect(env.KAFKA_SASL_USERNAME).toBeUndefined();
  });

  it('never invents a username for a password nobody gave', () => {
    expect(load({ KAFKA_SASL_USERNAME: 'fleet-service' }).KAFKA_SASL_PASSWORD).toBeUndefined();
    expect(kafkaSaslConfigured(load({ KAFKA_SASL_USERNAME: 'fleet-service' }))).toBe(false);
  });

  it.each(['plain', 'scram-sha-256', 'oauthbearer'])('refuses the %s mechanism', (mechanism) => {
    expect(() => load({ KAFKA_SASL_MECHANISM: mechanism })).toThrow(EnvValidationError);
  });

  it('reads TLS and its CA file', () => {
    const env = load({ KAFKA_SSL: 'true', KAFKA_SSL_CA_FILE: '/run/kafka/ca.pem' });
    expect(env.KAFKA_SSL).toBe(true);
    expect(env.KAFKA_SSL_CA_FILE).toBe('/run/kafka/ca.pem');
  });

  it.each([
    ['fleet-service', 'KAFKA_SASL_PASSWORD_FLEET'],
    ['audit-service', 'KAFKA_SASL_PASSWORD_AUDIT'],
    ['api-gateway', 'KAFKA_SASL_PASSWORD_API_GATEWAY'],
  ])('names %s’s shared variable %s', (service, variable) => {
    expect(kafkaPasswordVariable(service)).toBe(variable);
  });
});

/**
 * RUN-006, PM decision on #128: secure by default. PLAINTEXT only with the
 * explicit opt-out in an explicitly named development or test environment;
 * the opt-out anywhere else is refused at boot rather than ignored.
 */
describe('KAFKA_ALLOW_PLAINTEXT', () => {
  const kafkaService = baseEnvSchema.merge(kafkaEnvSchema);
  const source = {
    SERVICE_NAME: 'fleet-service',
    PORT: '3104',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'fleet-service',
  } as NodeJS.ProcessEnv;
  const load = (extra: Record<string, string> = {}) =>
    loadEnv(kafkaService, { ...source, ...extra } as NodeJS.ProcessEnv);

  it('is false by default, in every environment', () => {
    for (const NODE_ENV of ['development', 'test', 'staging', 'production']) {
      const env = load({ NODE_ENV });
      expect(env.KAFKA_ALLOW_PLAINTEXT).toBe(false);
      expect(kafkaPlaintextAllowed(env)).toBe(false);
    }
    expect(kafkaPlaintextAllowed(load())).toBe(false); // NODE_ENV omitted
  });

  it.each(['development', 'test'])('allows PLAINTEXT in %s with the opt-out', (NODE_ENV) => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      const env = load({ NODE_ENV, KAFKA_ALLOW_PLAINTEXT: value });
      expect(kafkaPlaintextAllowed(env)).toBe(true);
    }
  });

  it.each(['staging', 'production'])('refuses the opt-out at boot in %s', (NODE_ENV) => {
    expect(() => load({ NODE_ENV, KAFKA_ALLOW_PLAINTEXT: 'true' })).toThrow(
      /KAFKA_ALLOW_PLAINTEXT: is honoured only with NODE_ENV set explicitly to development or test/,
    );
  });

  it('refuses the opt-out with NODE_ENV omitted, although the schema defaults it to development', () => {
    expect(() => load({ KAFKA_ALLOW_PLAINTEXT: 'true' })).toThrow(EnvValidationError);
    expect(() => load({ NODE_ENV: ' ', KAFKA_ALLOW_PLAINTEXT: 'true' })).toThrow(
      EnvValidationError,
    );
  });

  it('refuses a spelling it does not know rather than guessing', () => {
    expect(() => load({ NODE_ENV: 'development', KAFKA_ALLOW_PLAINTEXT: 'si' })).toThrow(
      EnvValidationError,
    );
  });

  it('an explicit false is false', () => {
    const env = load({ NODE_ENV: 'development', KAFKA_ALLOW_PLAINTEXT: 'false' });
    expect(kafkaPlaintextAllowed(env)).toBe(false);
  });
});

/**
 * The outbox grace is a wait inside the shutdown the timeout bounds. A grace at
 * or above the timeout is a wait the process exits before finishing, so it is
 * refused at boot instead of discovered as a forced exit in production.
 */
describe('OUTBOX_SHUTDOWN_GRACE_SECONDS against SHUTDOWN_TIMEOUT_MS', () => {
  const schema = baseEnvSchema.merge(kafkaEnvSchema);
  const source = {
    SERVICE_NAME: 'fleet-service',
    PORT: '3104',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'fleet-service',
  } as NodeJS.ProcessEnv;
  const load = (overrides: Record<string, string> = {}) =>
    loadEnv(schema, { ...source, ...overrides } as NodeJS.ProcessEnv);

  it('accepts the defaults together: 20 s of grace inside a 25 s timeout', () => {
    const env = load();
    expect(env.OUTBOX_SHUTDOWN_GRACE_SECONDS * 1000).toBeLessThan(env.SHUTDOWN_TIMEOUT_MS);
  });

  it('accepts a grace one second under the timeout', () => {
    expect(
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '9', SHUTDOWN_TIMEOUT_MS: '10000' })
        .OUTBOX_SHUTDOWN_GRACE_SECONDS,
    ).toBe(9);
  });

  it.each([
    ['equal to the timeout', '10', '10000'],
    ['above the timeout', '30', '25000'],
    ['the old default against the default timeout', '30', '25000'],
  ])('refuses a grace %s', (_name, grace, timeout) => {
    expect(() =>
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: grace, SHUTDOWN_TIMEOUT_MS: timeout }),
    ).toThrow(EnvValidationError);
  });

  it('names both variables and both values, so the fix is not a search', () => {
    let message = '';
    try {
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '30', SHUTDOWN_TIMEOUT_MS: '25000' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('OUTBOX_SHUTDOWN_GRACE_SECONDS');
    expect(message).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(message).toContain('30 s');
    expect(message).toContain('25000 ms');
  });

  it('allows a zero grace whatever the timeout', () => {
    expect(load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '0', SHUTDOWN_TIMEOUT_MS: '1000' })).toMatchObject(
      {
        OUTBOX_SHUTDOWN_GRACE_SECONDS: 0,
      },
    );
  });

  it('is not asked of a service that has only one of the two', () => {
    expect(() =>
      loadEnv(baseEnvSchema, {
        SERVICE_NAME: 'api-gateway',
        PORT: '3000',
        SHUTDOWN_TIMEOUT_MS: '1000',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      loadEnv(kafkaEnvSchema, {
        KAFKA_BROKERS: 'localhost:9092',
        KAFKA_CLIENT_ID: 'fleet-service',
        OUTBOX_SHUTDOWN_GRACE_SECONDS: '300',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('raising the timeout is a fix, as the message says', () => {
    expect(
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '30', SHUTDOWN_TIMEOUT_MS: '40000' })
        .SHUTDOWN_TIMEOUT_MS,
    ).toBe(40_000);
  });
});
