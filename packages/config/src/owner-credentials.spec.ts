import {
  MigratorCredentialInServiceError,
  assertNoMigratorCredentials,
  migratorCredentialsIn,
} from './owner-credentials';

describe('a service never holds its database owner credential (D-045)', () => {
  const runtime = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://rasta_construction:secret@127.0.0.1:5433/rasta_construction',
    DATABASE_URL_CONSTRUCTION:
      'postgresql://rasta_construction:secret@127.0.0.1:5433/rasta_construction',
    POSTGRES_PASSWORD_CONSTRUCTION: 'runtime_password_value',
  };

  it('lets a runtime-only environment through', () => {
    expect(migratorCredentialsIn(runtime)).toEqual([]);
    expect(() => assertNoMigratorCredentials(runtime)).not.toThrow();
  });

  it('refuses any migrator URL or migrator password, of any service, naming each — never a value', () => {
    const env = {
      ...runtime,
      DATABASE_URL_ECONOMIC_MIGRATOR: 'postgresql://rasta_economic_migrator:owner_secret@h/db',
      POSTGRES_PASSWORD_AUDIT_MIGRATOR: 'owner_password_value',
    };
    expect(migratorCredentialsIn(env)).toEqual([
      'DATABASE_URL_ECONOMIC_MIGRATOR',
      'POSTGRES_PASSWORD_AUDIT_MIGRATOR',
    ]);
    let thrown: unknown;
    try {
      assertNoMigratorCredentials(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigratorCredentialInServiceError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/DATABASE_URL_ECONOMIC_MIGRATOR, POSTGRES_PASSWORD_AUDIT_MIGRATOR/);
    expect(message).not.toMatch(/owner_secret|owner_password_value/);
  });

  it('ignores an empty variable — set but holding nothing is not a credential', () => {
    expect(migratorCredentialsIn({ DATABASE_URL_SUPPLIER_MIGRATOR: '' })).toEqual([]);
  });

  it('does not mistake a name that merely mentions a migrator', () => {
    expect(
      migratorCredentialsIn({
        MIGRATOR_NOTES: 'x',
        DATABASE_URL_MIGRATOR_X: 'x',
        KAFKA_PASSWORD_MIGRATOR: 'x',
      }),
    ).toEqual([]);
  });
});

// The shared .env carries all service runtime URLs; privileged names alone fail boot.
describe('privileged database URL names', () => {
  it.each([
    'DATABASE_URL_ANALYTICS_TEST_ADMIN',
    'DATABASE_URL_ADMIN',
    'DATABASE_URL_ASSET_SUPERUSER',
    'DATABASE_URL_ECONOMIC_ADMIN',
  ])('refuses %s', (name) => {
    expect(migratorCredentialsIn({ [name]: 'credential' })).toEqual([name]);
    expect(() => assertNoMigratorCredentials({ [name]: 'credential' })).toThrow(name);
  });
  it('accepts all foreign runtime URLs from the shared example', () => {
    expect(() =>
      assertNoMigratorCredentials({
        DATABASE_URL_ANALYTICS: 'runtime',
        DATABASE_URL_ECONOMIC: 'runtime',
        DATABASE_URL_PROCUREMENT: 'runtime',
      }),
    ).not.toThrow();
  });
});
