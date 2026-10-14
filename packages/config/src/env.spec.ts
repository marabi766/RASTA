import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  assertStatementWaitsWithinTimeout,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  kafkaPasswordVariable,
  kafkaPlaintextAllowed,
  kafkaSaslConfigured,
  loadEnv,
  EnvValidationError,
  outboxPurgeEnvSchema,
  OUTBOX_PURGE_TRANSACTION_MARGIN_MS,
  outboxPurgeBatchBoundMs,
  OUTBOX_SHUTDOWN_RESERVE_MS,
  outboxShutdownBudgetMs,
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
  ])(
    'accepts DATABASE_URL %p, and opens its sessions in UTC with the default statement timeout',
    (value) => {
      expect(
        loadEnv(databaseEnvSchema, { DATABASE_URL: value } as NodeJS.ProcessEnv).DATABASE_URL,
      ).toBe(
        `${value}${value.includes('?') ? '&' : '?'}options=-c%20statement_timeout%3D15000%20-c%20TimeZone%3DUTC`,
      );
    },
  );

  it('applies the statement-timeout default when not specified', () => {
    const env = loadEnv(databaseEnvSchema, {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    } as NodeJS.ProcessEnv);

    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
  });
});

describe('the database pool and statement timeout (databaseEnvSchema)', () => {
  // Assembled rather than written out, so no line reads as a real connection
  // string to a secret scanner; the tests below look for it in every message.
  const PASSWORD = ['pool', 'spec', 'pw'].join('_');
  const RAW_URL = `postgresql://rasta_x:${PASSWORD}@db.internal:5432/rasta_x?schema=public`;
  /** The session options every runtime URL carries: the default statement timeout, then UTC. */
  const SESSION = `options=${encodeURIComponent('-c statement_timeout=15000 -c TimeZone=UTC')}`;

  const load = (pool: Record<string, string>, url = RAW_URL) =>
    loadEnv(databaseEnvSchema, { DATABASE_URL: url, ...pool } as NodeJS.ProcessEnv);

  /** The refusal `load` throws, checked to name the variable and carry no part of the URL. */
  const refusal = (pool: Record<string, string>, url = RAW_URL): EnvValidationError => {
    let caught: unknown;
    try {
      load(pool, url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const message = (caught as Error).message;
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('db.internal');
    return caught as EnvValidationError;
  };

  it('unset, writes no pool parameter: Prisma keeps its defaults', () => {
    const env = load({});
    expect(env.DATABASE_POOL_SIZE).toBeUndefined();
    expect(env.DATABASE_POOL_TIMEOUT_SECONDS).toBeUndefined();
    expect(env.DATABASE_URL).toBe(`${RAW_URL}&${SESSION}`);
  });

  it('writes both into DATABASE_URL as Prisma reads them, after the session options', () => {
    const env = load({ DATABASE_POOL_SIZE: '5', DATABASE_POOL_TIMEOUT_SECONDS: '3' });
    expect(env.DATABASE_POOL_SIZE).toBe(5);
    expect(env.DATABASE_POOL_TIMEOUT_SECONDS).toBe(3);
    expect(env.DATABASE_URL).toBe(`${RAW_URL}&${SESSION}&connection_limit=5&pool_timeout=3`);
  });

  it('writes either one alone', () => {
    expect(load({ DATABASE_POOL_SIZE: '8' }).DATABASE_URL).toBe(
      `${RAW_URL}&${SESSION}&connection_limit=8`,
    );
    expect(load({ DATABASE_POOL_TIMEOUT_SECONDS: '4' }).DATABASE_URL).toBe(
      `${RAW_URL}&${SESSION}&pool_timeout=4`,
    );
  });

  it('accepts both bounds', () => {
    expect(load({ DATABASE_POOL_SIZE: '1', DATABASE_POOL_TIMEOUT_SECONDS: '1' }).DATABASE_URL).toBe(
      `${RAW_URL}&${SESSION}&connection_limit=1&pool_timeout=1`,
    );
    expect(
      load({ DATABASE_POOL_SIZE: '100', DATABASE_POOL_TIMEOUT_SECONDS: '60' }).DATABASE_URL,
    ).toBe(`${RAW_URL}&${SESSION}&connection_limit=100&pool_timeout=60`);
  });

  it.each(['0', '101', '', ' 5', '5 ', '5.0', '1e1', '0x10', '-1', '+5', 'ten'])(
    'refuses DATABASE_POOL_SIZE=%p rather than guessing',
    (value) => {
      expect(refusal({ DATABASE_POOL_SIZE: value }).issues.map((i) => i.path)).toEqual([
        'DATABASE_POOL_SIZE',
      ]);
    },
  );

  it.each(['0', '61', '', '1.5', '2s', '-3'])(
    'refuses DATABASE_POOL_TIMEOUT_SECONDS=%p (0 would be Prisma’s wait-forever)',
    (value) => {
      expect(refusal({ DATABASE_POOL_TIMEOUT_SECONDS: value }).issues.map((i) => i.path)).toEqual([
        'DATABASE_POOL_TIMEOUT_SECONDS',
      ]);
    },
  );

  it('refuses a size the URL already sets differently, naming neither the URL nor its password', () => {
    const issues = refusal({ DATABASE_POOL_SIZE: '5' }, `${RAW_URL}&connection_limit=16`).issues;
    expect(issues).toEqual([
      { path: 'DATABASE_POOL_SIZE', message: expect.stringContaining('connection_limit') },
    ]);
  });

  it('refuses a wait the URL already sets differently', () => {
    expect(
      refusal({ DATABASE_POOL_TIMEOUT_SECONDS: '3' }, `${RAW_URL}&pool_timeout=10`).issues.map(
        (i) => i.path,
      ),
    ).toEqual(['DATABASE_POOL_TIMEOUT_SECONDS']);
  });

  it('keeps a URL’s own connection_limit when the variable is unset or agrees', () => {
    const own = `${RAW_URL}&connection_limit=16`;
    expect(load({}, own).DATABASE_URL).toBe(`${own}&${SESSION}`);
    expect(load({ DATABASE_POOL_SIZE: '16' }, own).DATABASE_URL).toBe(`${own}&${SESSION}`);
  });

  describe('DATABASE_STATEMENT_TIMEOUT_MS (Codex r1 on #268: declared, now in effect)', () => {
    const options = (env: { DATABASE_URL: string }) =>
      new URL(env.DATABASE_URL).searchParams.get('options');

    it('writes the configured value into the session options, before the UTC option', () => {
      const env = load({ DATABASE_STATEMENT_TIMEOUT_MS: '30000' });
      expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
      expect(options(env)).toBe('-c statement_timeout=30000 -c TimeZone=UTC');
    });

    it('keeps the URL’s other options, and the result is stable under withUtcSession', () => {
      const own = `${RAW_URL}&options=${encodeURIComponent('-c search_path=x')}`;
      const env = load({ DATABASE_STATEMENT_TIMEOUT_MS: '2000' }, own);
      expect(options(env)).toBe('-c search_path=x -c statement_timeout=2000 -c TimeZone=UTC');
      // Loading the loaded URL again changes nothing (a CLI handing it on).
      expect(load({ DATABASE_STATEMENT_TIMEOUT_MS: '2000' }, env.DATABASE_URL).DATABASE_URL).toBe(
        env.DATABASE_URL,
      );
    });

    it('accepts both bounds', () => {
      expect(options(load({ DATABASE_STATEMENT_TIMEOUT_MS: '1000' }))).toContain(
        'statement_timeout=1000 ',
      );
      expect(options(load({ DATABASE_STATEMENT_TIMEOUT_MS: '3600000' }))).toContain(
        'statement_timeout=3600000 ',
      );
    });

    it.each(['0', '999', '3600001', '', ' 15000', '15000ms', '15s', '1.5e4', '-1'])(
      'refuses DATABASE_STATEMENT_TIMEOUT_MS=%p (0 would be PostgreSQL’s no-limit)',
      (value) => {
        expect(refusal({ DATABASE_STATEMENT_TIMEOUT_MS: value }).issues.map((i) => i.path)).toEqual(
          ['DATABASE_STATEMENT_TIMEOUT_MS'],
        );
      },
    );

    it.each([
      '-c statement_timeout=5000',
      '-cstatement_timeout=5000',
      '--statement-timeout=5000',
      '-c STATEMENT_TIMEOUT=15000 -c statement_timeout=5000',
    ])('refuses a URL whose options %p set another value', (written) => {
      const issues = refusal({}, `${RAW_URL}&options=${encodeURIComponent(written)}`).issues;
      expect(issues).toEqual([
        {
          path: 'DATABASE_STATEMENT_TIMEOUT_MS',
          message: expect.stringContaining('statement_timeout'),
        },
      ]);
    });

    it('keeps a URL whose options already set the same value', () => {
      const own = `${RAW_URL}&options=${encodeURIComponent('-c statement_timeout=15000')}`;
      expect(options(load({}, own))).toBe('-c statement_timeout=15000 -c TimeZone=UTC');
    });
  });

  it('a schema without DATABASE_URL is left alone', () => {
    const env = loadEnv(baseEnvSchema, {
      SERVICE_NAME: 'api-gateway',
      PORT: '3000',
      DATABASE_POOL_SIZE: 'ten',
    } as NodeJS.ProcessEnv);
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('DATABASE_POOL_SIZE');
  });
});

describe('a wait the settings allow, against the statement timeout (#268 r3)', () => {
  const env = { DATABASE_STATEMENT_TIMEOUT_MS: 15_000 };
  const wait = (variable: string, worstCaseMs: number) => ({
    variable,
    worstCaseMs,
    derivation: 'a test wait',
  });

  it('accepts every wait shorter than the statement timeout, and no waits at all', () => {
    expect(() => assertStatementWaitsWithinTimeout(env, [wait('A_MS', 14_999)])).not.toThrow();
    expect(() => assertStatementWaitsWithinTimeout(env, [])).not.toThrow();
  });

  it('refuses a wait as long as the statement timeout: the statement would be cancelled first', () => {
    expect(() => assertStatementWaitsWithinTimeout(env, [wait('A_MS', 15_000)])).toThrow(
      EnvValidationError,
    );
  });

  it('names every setting that does not fit, with its worst case and how it is made up', () => {
    let thrown: unknown;
    try {
      assertStatementWaitsWithinTimeout(env, [
        wait('A_MS', 15_000),
        wait('B_MS', 1_000),
        wait('C_MS', 60_000),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvValidationError);
    const issues = (thrown as EnvValidationError).issues;
    expect(issues.map((issue) => issue.path)).toEqual(['A_MS', 'C_MS']);
    expect(issues[1]!.message).toContain('up to 60000 ms (a test wait)');
    expect(issues[1]!.message).toContain('DATABASE_STATEMENT_TIMEOUT_MS (15000 ms)');
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
 * D-052: the outbox purge. Fail closed — a value that is missing its digits,
 * out of range or not a number refuses to boot, rather than falling through to
 * a retention that deletes what an operator meant to keep.
 */
describe('outbox purge (D-052)', () => {
  const schema = baseEnvSchema.merge(outboxPurgeEnvSchema);
  const base = { SERVICE_NAME: 'fleet-service', PORT: '3104' };
  const load = (overrides: Record<string, string> = {}) =>
    loadEnv(schema, { ...base, ...overrides } as NodeJS.ProcessEnv);

  it('is on by default, keeping ADR-050’s seven days, in bounded batches', () => {
    const env = load();

    expect(env.OUTBOX_PURGE_ENABLED).toBe(true);
    expect(env.OUTBOX_PURGE_RETENTION_HOURS).toBe(168);
    expect(env.OUTBOX_PURGE_INTERVAL_SECONDS).toBe(300);
    expect(env.OUTBOX_PURGE_BATCH_SIZE).toBe(1000);
    expect(env.OUTBOX_PURGE_MAX_BATCHES_PER_RUN).toBe(10);
    expect(env.OUTBOX_PURGE_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(env.OUTBOX_PURGE_MAX_WAIT_MS).toBe(2000);
  });

  it('reads explicit values', () => {
    const env = load({
      OUTBOX_PURGE_ENABLED: 'off',
      OUTBOX_PURGE_RETENTION_HOURS: '72',
      OUTBOX_PURGE_INTERVAL_SECONDS: '60',
      OUTBOX_PURGE_BATCH_SIZE: '250',
      OUTBOX_PURGE_MAX_BATCHES_PER_RUN: '4',
      OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '2000',
      OUTBOX_PURGE_MAX_WAIT_MS: '750',
    });

    expect(env.OUTBOX_PURGE_ENABLED).toBe(false);
    expect(env.OUTBOX_PURGE_RETENTION_HOURS).toBe(72);
    expect(env.OUTBOX_PURGE_INTERVAL_SECONDS).toBe(60);
    expect(env.OUTBOX_PURGE_BATCH_SIZE).toBe(250);
    expect(env.OUTBOX_PURGE_MAX_BATCHES_PER_RUN).toBe(4);
    expect(env.OUTBOX_PURGE_STATEMENT_TIMEOUT_MS).toBe(2000);
    expect(env.OUTBOX_PURGE_MAX_WAIT_MS).toBe(750);
  });

  it.each([
    ['OUTBOX_PURGE_RETENTION_HOURS', ['0', '-1', '8761', '', 'abc', '1.5', '7d']],
    ['OUTBOX_PURGE_INTERVAL_SECONDS', ['9', '0', '86401', '', 'often']],
    ['OUTBOX_PURGE_BATCH_SIZE', ['0', '10001', '', '100.5']],
    ['OUTBOX_PURGE_MAX_BATCHES_PER_RUN', ['0', '1001', '', 'x']],
    ['OUTBOX_PURGE_STATEMENT_TIMEOUT_MS', ['99', '60001', '', '5s']],
    ['OUTBOX_PURGE_MAX_WAIT_MS', ['99', '60001', '', '2s', '-1']],
    ['OUTBOX_PURGE_ENABLED', ['maybe', '2', 'enabled']],
  ])('refuses an invalid %s', (name, values) => {
    for (const value of values) {
      expect(() => load({ [name]: value })).toThrow(EnvValidationError);
    }
  });

  it('the batch bound is the connection wait, the statement and the transaction margin', () => {
    expect(OUTBOX_PURGE_TRANSACTION_MARGIN_MS).toBe(5000);
    expect(outboxPurgeBatchBoundMs({ maxWaitMs: 2000, statementTimeoutMs: 5000 })).toBe(12_000);
  });

  it('the outbox shutdown budget is the timeout less the reserve for the rest of the close', () => {
    expect(OUTBOX_SHUTDOWN_RESERVE_MS).toBe(2000);
    expect(outboxShutdownBudgetMs({ SHUTDOWN_TIMEOUT_MS: 25_000 })).toBe(23_000);
  });

  // Codex r1 on #247: the check used to budget the statement alone, while
  // each batch also waits for a connection and runs to Prisma's timeout. r2:
  // the batch bound is held to the outbox shutdown budget, not the bare timeout.
  it('refuses a configuration whose whole batch bound the shutdown budget could not wait out', () => {
    // 2000 + 16000 + 5000 = 23000: exactly the budget of a 25000 ms timeout.
    expect(
      load({
        OUTBOX_PURGE_MAX_WAIT_MS: '2000',
        OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '16000',
        SHUTDOWN_TIMEOUT_MS: '25000',
      }).OUTBOX_PURGE_STATEMENT_TIMEOUT_MS,
    ).toBe(16_000);
    // One millisecond more, from either side, is refused.
    for (const overrides of [
      { OUTBOX_PURGE_MAX_WAIT_MS: '2000', OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '16001' },
      { OUTBOX_PURGE_MAX_WAIT_MS: '2001', OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '16000' },
    ]) {
      expect(() => load({ ...overrides, SHUTDOWN_TIMEOUT_MS: '25000' })).toThrow(
        /one purge batch may take 23001 ms .*more than the outbox shutdown budget of 23000 ms \(SHUTDOWN_TIMEOUT_MS 25000 ms − 2000 ms/,
      );
    }
    // The r1 boundary (a 24999 ms batch under a 25000 ms timeout) left nothing
    // for the rest of the close; it is refused now.
    expect(() =>
      load({ OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '17999', SHUTDOWN_TIMEOUT_MS: '25000' }),
    ).toThrow(/24999 ms/);
    // The statement alone under the shutdown timeout is no longer enough: the
    // r1 configuration (statement 24999) is refused.
    expect(() =>
      load({ OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '24999', SHUTDOWN_TIMEOUT_MS: '25000' }),
    ).toThrow(/OUTBOX_PURGE_STATEMENT_TIMEOUT_MS/);
    // A long connection wait alone is refused too.
    expect(() => load({ OUTBOX_PURGE_MAX_WAIT_MS: '20000', SHUTDOWN_TIMEOUT_MS: '25000' })).toThrow(
      /20000 ms waiting for a connection/,
    );
  });
});

/**
 * Codex r2 on #247: a service with the relay and the purge drains both in one
 * shutdown. They run concurrently against one deadline (`OutboxShutdown`), so
 * the worst case is the longer of the relay's grace and the purge's batch
 * bound — and that, not each on its own against the bare timeout, is what
 * must fit the outbox shutdown budget.
 */
describe('the outbox shutdown path as one worst case (relay + purge)', () => {
  const schema = baseEnvSchema.merge(kafkaEnvSchema).merge(outboxPurgeEnvSchema);
  const source = {
    SERVICE_NAME: 'fleet-service',
    PORT: '3104',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'fleet-service',
  };
  const load = (overrides: Record<string, string> = {}) =>
    loadEnv(schema, { ...source, ...overrides } as NodeJS.ProcessEnv);

  it('accepts the defaults: max(20 s grace, 12 s batch) inside 25 s − 2 s', () => {
    const env = load();
    expect(env.OUTBOX_SHUTDOWN_GRACE_SECONDS).toBe(20);
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(25_000);
  });

  it('accepts the r2 example — a 10 s batch beside a 20 s grace — because they overlap', () => {
    // 1000 + 4000 + 5000 = 10 s, and 20 s: 30 s in sequence, 20 s concurrently.
    expect(
      load({
        OUTBOX_PURGE_MAX_WAIT_MS: '1000',
        OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '4000',
        OUTBOX_SHUTDOWN_GRACE_SECONDS: '20',
        SHUTDOWN_TIMEOUT_MS: '25000',
      }).OUTBOX_SHUTDOWN_GRACE_SECONDS,
    ).toBe(20);
  });

  it('holds the grace to the budget too, where the relay alone only needs it under the timeout', () => {
    // 23 s fits 25 s − 2 s; 24 s passes the relay-only rule (< 25 s) but not the shared budget.
    expect(
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '23', SHUTDOWN_TIMEOUT_MS: '25000' })
        .OUTBOX_SHUTDOWN_GRACE_SECONDS,
    ).toBe(23);
    expect(() =>
      load({ OUTBOX_SHUTDOWN_GRACE_SECONDS: '24', SHUTDOWN_TIMEOUT_MS: '25000' }),
    ).toThrow(
      /OUTBOX_SHUTDOWN_GRACE_SECONDS: \(24 s\) is more than the outbox shutdown budget of 23000 ms/,
    );
    // A relay-only service keeps its own rule.
    expect(
      loadEnv(baseEnvSchema.merge(kafkaEnvSchema), {
        ...source,
        OUTBOX_SHUTDOWN_GRACE_SECONDS: '24',
        SHUTDOWN_TIMEOUT_MS: '25000',
      } as NodeJS.ProcessEnv).OUTBOX_SHUTDOWN_GRACE_SECONDS,
    ).toBe(24);
  });

  it('reports both when both overrun the budget', () => {
    let issues: { path: string }[] = [];
    try {
      load({
        OUTBOX_SHUTDOWN_GRACE_SECONDS: '9',
        OUTBOX_PURGE_STATEMENT_TIMEOUT_MS: '3000',
        SHUTDOWN_TIMEOUT_MS: '10000',
      });
    } catch (error) {
      issues = (error as EnvValidationError).issues;
    }
    expect(issues.map((issue) => issue.path)).toEqual([
      'OUTBOX_PURGE_STATEMENT_TIMEOUT_MS',
      'OUTBOX_SHUTDOWN_GRACE_SECONDS',
    ]);
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
