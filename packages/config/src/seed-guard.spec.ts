import {
  DISPOSABLE_DATABASE_PROBE_SQL,
  DemoSeedRefusedError,
  assertDemoSeedAllowed,
  assertDemoSeedDatabase,
  demoSeedRefusals,
} from './seed-guard';

/**
 * The demo-seed gate. Fail closed is the whole point: every case that is not
 * explicitly a development or test run with the opt-in typed must refuse.
 */
describe('assertDemoSeedAllowed', () => {
  const allowed = { NODE_ENV: 'development', RASTA_ALLOW_DEMO_SEED: 'true' };

  it.each([
    ['development', { ...allowed }],
    ['test', { ...allowed, NODE_ENV: 'test' }],
  ])('lets a %s run with the opt-in through', (_label, env) => {
    expect(() => assertDemoSeedAllowed('organization-service', env)).not.toThrow();
  });

  it.each([
    ['production', { ...allowed, NODE_ENV: 'production' }],
    ['staging', { ...allowed, NODE_ENV: 'staging' }],
    ['an unset NODE_ENV', { RASTA_ALLOW_DEMO_SEED: 'true' }],
    ['a blank NODE_ENV', { ...allowed, NODE_ENV: '  ' }],
    ['an unknown NODE_ENV', { ...allowed, NODE_ENV: 'dev' }],
    ['no opt-in', { NODE_ENV: 'development' }],
    ['an opt-in of "1"', { ...allowed, RASTA_ALLOW_DEMO_SEED: '1' }],
    ['an opt-in of "TRUE"', { ...allowed, RASTA_ALLOW_DEMO_SEED: 'TRUE' }],
    ['an opt-in of "yes"', { ...allowed, RASTA_ALLOW_DEMO_SEED: 'yes' }],
    ['production even with the opt-in', { NODE_ENV: 'production', RASTA_ALLOW_DEMO_SEED: 'true' }],
  ])('refuses %s', (_label, env) => {
    expect(() => assertDemoSeedAllowed('organization-service', env)).toThrow(DemoSeedRefusedError);
  });

  it('names every failed condition, not only the first', () => {
    expect(demoSeedRefusals({ NODE_ENV: 'production' })).toEqual([
      'NODE_ENV is not a development or test environment',
      'RASTA_ALLOW_DEMO_SEED is not "true"',
    ]);
  });

  it('never echoes a value it read', () => {
    // A refusal lands in terminals and CI logs; the value it rejected could be
    // anything an operator pasted into the variable.
    const error = (() => {
      try {
        assertDemoSeedAllowed('identity-service', {
          NODE_ENV: 'prod-eu-secret-marker',
          RASTA_ALLOW_DEMO_SEED: 'opt-in-secret-marker',
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected a refusal');
    })();

    expect(error.message).not.toContain('secret-marker');
    expect(error.message).toContain('identity-service');
    expect(error.message).toContain('Nothing was written');
  });

  it('reads process.env by default', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.RASTA_ALLOW_DEMO_SEED = 'true';
      expect(() => assertDemoSeedAllowed('asset-service')).toThrow(DemoSeedRefusedError);
    } finally {
      process.env = saved;
    }
  });
});

/**
 * The target database has the last word (Codex post-merge review of #105,
 * finding 1): a shell with NODE_ENV=development, the opt-in and a
 * `DATABASE_URL_*` pasted from production passes the environment checks, so
 * the seed must also find the marker in the database it is about to write.
 *
 * That the probe reads the stored setting, and that only the superuser can
 * write it, is proven against PostgreSQL by `scripts/verify-seed-guard.mjs
 * --with-database`.
 */
describe('assertDemoSeedDatabase', () => {
  const allowed = { NODE_ENV: 'development', RASTA_ALLOW_DEMO_SEED: 'true' };
  const answering = (rows: unknown) => ({
    $queryRawUnsafe: jest.fn(async (_query: string) => rows),
  });

  it('lets a marked database through, after asking it with the catalog probe', async () => {
    const client = answering([{ marked: true }]);

    await expect(assertDemoSeedDatabase('identity-service', client, allowed)).resolves.toBe(
      undefined,
    );
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(DISPOSABLE_DATABASE_PROBE_SQL);
  });

  it('refuses a database without the marker', async () => {
    const error = await assertDemoSeedDatabase(
      'identity-service',
      answering([{ marked: false }]),
      allowed,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DemoSeedRefusedError);
    expect((error as DemoSeedRefusedError).reasons).toEqual([
      'the target database is not marked as a disposable development or test database',
    ]);
    expect((error as Error).message).toContain('Nothing was written');
  });

  it.each([
    ['no rows', []],
    ['two rows', [{ marked: true }, { marked: true }]],
    ['a string "true"', [{ marked: 'true' }]],
    ['a null row', [null]],
    ['not an array', { marked: true }],
    ['undefined', undefined],
  ])('fails closed on an answer of %s', async (_label, rows) => {
    await expect(
      assertDemoSeedDatabase('identity-service', answering(rows), allowed),
    ).rejects.toBeInstanceOf(DemoSeedRefusedError);
  });

  it('refuses when the database cannot be asked, without echoing why', async () => {
    const client = {
      $queryRawUnsafe: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED prod-db.internal:5432 as rasta_identity');
      }),
    };

    const error = (await assertDemoSeedDatabase('identity-service', client, allowed).catch(
      (caught: unknown) => caught,
    )) as Error;

    expect(error).toBeInstanceOf(DemoSeedRefusedError);
    expect(error.message).not.toContain('prod-db');
    expect(error.message).not.toContain('rasta_identity');
  });

  it.each([
    ['production', { ...allowed, NODE_ENV: 'production' }],
    ['no opt-in', { NODE_ENV: 'development' }],
  ])('refuses %s even on a marked database, without asking it', async (_label, env) => {
    const client = answering([{ marked: true }]);

    await expect(assertDemoSeedDatabase('identity-service', client, env)).rejects.toBeInstanceOf(
      DemoSeedRefusedError,
    );
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reads the stored setting, never the session value a client can set', () => {
    expect(DISPOSABLE_DATABASE_PROBE_SQL).toContain('pg_catalog.pg_db_role_setting');
    expect(DISPOSABLE_DATABASE_PROBE_SQL).toContain('pg_catalog.current_database()');
    expect(DISPOSABLE_DATABASE_PROBE_SQL).toContain('s.setrole = 0');
    expect(DISPOSABLE_DATABASE_PROBE_SQL).not.toMatch(/current_setting/i);
  });
});
