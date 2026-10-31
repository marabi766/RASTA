import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  DATABASE_SERVICES,
  MigratorCredentialInServiceError,
  REGISTERED_MIGRATOR_CREDENTIALS,
  RUNTIME_DATABASE_ROLES,
  assertNoMigratorCredentials,
  migratorCredentialsIn,
  privilegedDatabaseUrlsIn,
} from './owner-credentials';

const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'];
/** Any piece of either sentinel, in any spelling (upper-cased, `-` as `_`). */
const FRAGMENTS = /sentinel|jz97|another[-_]secret/i;

/** Everything a thrown error prints: message, stack, its properties, an uncaught throw's inspection. */
function everythingOf(error: Error): string {
  return [
    error.message,
    error.stack ?? '',
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
    inspect(error, { depth: 10, showHidden: true }),
  ].join('\n');
}

function refusalOf(env: NodeJS.ProcessEnv): MigratorCredentialInServiceError {
  try {
    assertNoMigratorCredentials(env);
  } catch (error) {
    return error as MigratorCredentialInServiceError;
  }
  throw new Error('expected a refusal');
}

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

  it('holds DATABASE_SERVICES to the services that own a database', () => {
    const services = join(__dirname, '../../../services');
    const owning = readdirSync(services)
      .filter((name) => name.endsWith('-service') && existsSync(join(services, name, 'prisma')))
      .map((name) => name.slice(0, -'-service'.length).replaceAll('-', '_').toUpperCase())
      .sort();
    expect([...DATABASE_SERVICES]).toEqual(owning);
    // Per service: its runtime URL, its migrator's URL and password, six
    // privileged URL suffixes, its test harness's admin URL; and twelve shared.
    expect(REGISTERED_MIGRATOR_CREDENTIALS.size).toBe(owning.length * 10 + 12);
  });

  // #385 r4: detected by the pattern, named only from the registered list. An
  // unregistered name came from the environment: counted, and repeated in no
  // part of the error — upper-cased and with `-` as `_`, as a key spells it,
  // under either prefix.
  it('counts an owner credential named for no service, and never repeats its name', () => {
    for (const sentinel of SENTINELS) {
      const key = sentinel.replaceAll('-', '_').toUpperCase();
      for (const name of [`DATABASE_URL_${key}_MIGRATOR`, `POSTGRES_PASSWORD_${key}_MIGRATOR`]) {
        const error = refusalOf({ ...runtime, [name]: `postgresql://m:${sentinel}@h/db` });
        expect(error).toBeInstanceOf(MigratorCredentialInServiceError);
        expect(error.message).toContain('(1 more *_MIGRATOR variable(s) named for no service)');
        expect(error.variables).toEqual([]);
        expect(error.unregistered).toBe(1);
        expect(everythingOf(error)).not.toMatch(FRAGMENTS);
      }
      const both = refusalOf({
        DATABASE_URL_AUDIT_MIGRATOR: 'x',
        [`DATABASE_URL_${key}_MIGRATOR`]: 'x',
        [`POSTGRES_PASSWORD_${key}_MIGRATOR`]: 'x',
      });
      expect(both.message).toContain(
        '(DATABASE_URL_AUDIT_MIGRATOR, 2 more *_MIGRATOR variable(s) named for no service)',
      );
      expect(everythingOf(both)).not.toMatch(FRAGMENTS);
    }
  });

  // #385 r6: #421 refuses privileged URL names too. Those of a database
  // service (and DATABASE_URL_ADMIN) are registered, so a refusal names them;
  // any other name the pattern may match is still counted, never named.
  it('names a privileged URL of a database service, counts any other', () => {
    const error = new MigratorCredentialInServiceError([
      'DATABASE_URL_ADMIN',
      'DATABASE_URL_ANALYTICS_TEST_ADMIN',
      'DATABASE_URL_ASSET_SUPERUSER',
      'DATABASE_URL_ECONOMIC_ADMIN',
      `DATABASE_URL_${SENTINELS[0].replaceAll('-', '_').toUpperCase()}_ADMIN`,
    ]);
    expect(error.variables).toEqual([
      'DATABASE_URL_ADMIN',
      'DATABASE_URL_ANALYTICS_TEST_ADMIN',
      'DATABASE_URL_ASSET_SUPERUSER',
      'DATABASE_URL_ECONOMIC_ADMIN',
    ]);
    expect(error.unregistered).toBe(1);
    expect(everythingOf(error)).not.toMatch(FRAGMENTS);
  });
});

const ROOT = join(__dirname, '../../..');
const SENTINEL_PASSWORD = 'pw-sentinel-4417';
const url = (user: string, rest = `:${SENTINEL_PASSWORD}@127.0.0.1:5433/rasta_economic`) =>
  `postgresql://${user}${rest}`;

/** `NAME=value` lines of an env file, as `node --env-file` reads them (no quoting in ours). */
function envFile(name: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    readFileSync(join(ROOT, name), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

// #421 r1 F2: by name, the credentials that carry no URL to read — and the
// names really in use (CI's TEST_ANALYTICS_ADMIN_URL, the bootstrap's
// POSTGRES_SUPERUSER_PASSWORD), not a spelling nobody uses.
describe('privileged credential names', () => {
  it.each([
    'TEST_ANALYTICS_ADMIN_URL',
    'POSTGRES_SUPERUSER_PASSWORD',
    'POSTGRES_PASSWORD',
    'PGPASSWORD',
    'DATABASE_URL_ADMIN',
    'DATABASE_URL_ASSET_SUPERUSER',
    'DATABASE_URL_ECONOMIC_ADMIN',
    'DATABASE_URL_ECONOMIC_OWNER',
    'DATABASE_URL_PROCUREMENT_DBA',
    'DATABASE_URL_IDENTITY_ROOT',
  ])('refuses %s, naming it', (name) => {
    expect(migratorCredentialsIn({ [name]: 'credential' })).toEqual([name]);
    expect(refusalOf({ [name]: 'credential' }).variables).toEqual([name]);
  });

  it('leaves a runtime role password and other services runtime settings alone', () => {
    expect(
      migratorCredentialsIn({
        POSTGRES_PASSWORD_ECONOMIC: 'runtime_password_value',
        POSTGRES_SUPERUSER: 'rasta',
        DATABASE_URL_ANALYTICS: url('rasta_analytics'),
      }),
    ).toEqual([]);
  });
});

// #421 r1 F2: by value — whatever the variable is called.
describe('database URLs, by the role they connect as', () => {
  it.each([...RUNTIME_DATABASE_ROLES])('lets %s through, under any name', (role) => {
    const env = { DATABASE_URL: url(role), SOME_OTHER_DSN: url(role).replace('ql://', '://') };
    expect(privilegedDatabaseUrlsIn(env)).toEqual([]);
    expect(() => assertNoMigratorCredentials(env)).not.toThrow();
  });

  it.each([
    ['a migrator', url('rasta_economic_migrator')],
    ['the superuser', url('rasta')],
    ['a role no service has', url('app_owner')],
    ['no user at all: the client would choose one', 'postgresql://127.0.0.1:5433/rasta_economic'],
    ['a percent-encoded migrator', url('rasta%5Feconomic%5Fmigrator')],
    ['an undecodable user', url('rasta_econ%E0%A4%A')],
    ['a percent-encoded runtime role: never decoded', url('rasta%5Feconomic')],
    ['an upper-case scheme', url('rasta_economic_migrator').replace('postgresql', 'POSTGRESQL')],
    ['the short scheme', url('rasta_audit_migrator').replace('postgresql', 'postgres')],
    ['a runtime user overridden by ?user=', `${url('rasta_economic')}?user=rasta`],
    ['an empty ?user=', `${url('rasta_economic')}?user=`],
    ['a URL inside other text', `jdbc:${url('rasta_economic')}`],
    ['a URL after whitespace', ` ${url('rasta_economic')}`],
    ['an unreadable URL', 'postgresql://rasta_economic:x@[::1/rasta_economic'],
  ])('refuses %s', (_case, value) => {
    expect(privilegedDatabaseUrlsIn({ DATABASE_URL: value })).toEqual(['DATABASE_URL']);
    const error = refusalOf({ DATABASE_URL: value });
    expect(error.variables).toEqual(['DATABASE_URL']);
    expect(everythingOf(error)).not.toContain(SENTINEL_PASSWORD);
  });

  it('names a registered variable, counts any other, and repeats no value', () => {
    for (const sentinel of SENTINELS) {
      const key = sentinel.replaceAll('-', '_').toUpperCase();
      const error = refusalOf({
        DATABASE_URL_PROCUREMENT: url('rasta_procurement_migrator'),
        [`${key}_DSN`]: url('rasta', `:${sentinel}@h/db`),
      });
      expect(error.variables).toEqual(['DATABASE_URL_PROCUREMENT']);
      expect(error.unregisteredUrls).toBe(1);
      expect(error.message).toContain(
        '(DATABASE_URL_PROCUREMENT, 1 more variable(s) holding a database URL for no runtime role)',
      );
      expect(everythingOf(error)).not.toMatch(FRAGMENTS);
      expect(everythingOf(error)).not.toContain(SENTINEL_PASSWORD);
    }
  });

  it('counts a variable found by both layers once', () => {
    const error = refusalOf({ DATABASE_URL_ECONOMIC_MIGRATOR: url('rasta_economic_migrator') });
    expect(error.variables).toEqual(['DATABASE_URL_ECONOMIC_MIGRATOR']);
    expect(error.unregistered + error.unregisteredUrls).toBe(0);
  });

  it('leaves every other kind of URL alone', () => {
    expect(
      privilegedDatabaseUrlsIn({
        REDIS_URL: 'redis://localhost:6379',
        OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
        NOTES: 'postgres is the database',
      }),
    ).toEqual([]);
  });

  it('allows exactly the runtime roles of lib/role-passwords.bash RASTA_SERVICES', () => {
    const library = readFileSync(
      join(ROOT, 'infrastructure/docker/postgres/lib/role-passwords.bash'),
      'utf8',
    );
    const services = /^RASTA_SERVICES=\(([\s\S]*?)^\)/m
      .exec(library)![1]
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
    expect([...RUNTIME_DATABASE_ROLES].sort()).toEqual(
      services.map((service) => `rasta_${service}`).sort(),
    );
  });
});

// The service runtime environment boots; the bootstrap, migration and test
// credentials — .env.migrator — do not (PM addendum to #421 r1 F2).
describe('the shared example files', () => {
  it('.env.example, which every service loads, holds nothing either layer refuses', () => {
    const env = envFile('.env.example');
    expect(Object.keys(env).length).toBeGreaterThan(50);
    expect(migratorCredentialsIn(env)).toEqual([]);
    expect(privilegedDatabaseUrlsIn(env)).toEqual([]);
    expect(() => assertNoMigratorCredentials(env)).not.toThrow();
  });

  it('.env.migrator.example is refused, every migrator URL and password by name', () => {
    const env = envFile('.env.migrator.example');
    const error = refusalOf({ ...envFile('.env.example'), ...env });
    const urls = Object.keys(env).filter((name) => name.startsWith('DATABASE_URL_'));
    expect(urls.length).toBe(DATABASE_SERVICES.length);
    expect(privilegedDatabaseUrlsIn(env)).toEqual(urls.sort());
    expect(error.variables).toEqual(Object.keys(env).sort());
  });
});
