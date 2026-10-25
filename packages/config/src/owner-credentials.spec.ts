import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  DATABASE_SERVICES,
  MigratorCredentialInServiceError,
  REGISTERED_MIGRATOR_CREDENTIALS,
  assertNoMigratorCredentials,
  migratorCredentialsIn,
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
    expect(REGISTERED_MIGRATOR_CREDENTIALS.size).toBe(owning.length * 5 + 1);
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
