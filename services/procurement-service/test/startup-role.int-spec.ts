import { migratorCredentialsIn, privilegedDatabaseUrlsIn, withUtcSession } from '@rasta/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

/**
 * procurement-service refuses to start as anything but its runtime role (D-045,
 * `docs/runbooks/db-role-split.md` § 7.5).
 *
 * `assertNoMigratorCredentials` (main.ts) keeps every `*_MIGRATOR` variable out of the service's
 * environment, but a `DATABASE_URL` that simply names the migrator carries no such variable and
 * would pass it. So `AppModule` first asks the catalogue who the connection really is
 * (`PrismaService.assertRuntimeRole`) and stops before it serves, sweeps or relays anything.
 */
function migratorUrl(): string {
  const url = process.env.DATABASE_URL_PROCUREMENT_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_PROCUREMENT_MIGRATOR is not set; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

describe('procurement-service starts only as its runtime role (D-045)', () => {
  const opened: PrismaService[] = [];
  const open = (url: string) => {
    const prisma = new PrismaService(url);
    opened.push(prisma);
    return prisma;
  };

  afterAll(async () => {
    await Promise.all(opened.map((prisma) => prisma.onModuleDestroy()));
  });

  it('accepts the runtime role', async () => {
    await expect(open(databaseUrl()).assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('refuses a DATABASE_URL that names the migrator, which no *_MIGRATOR variable reveals', async () => {
    // The name gives nothing away; the value does, and the environment guard
    // refuses it first (#421 r1 F2) — the connected role is the second gate.
    expect(migratorCredentialsIn({ DATABASE_URL: migratorUrl() })).toEqual([]);
    expect(privilegedDatabaseUrlsIn({ DATABASE_URL: migratorUrl() })).toEqual(['DATABASE_URL']);
    await expect(open(migratorUrl()).assertRuntimeRole()).rejects.toThrow(
      /procurement-service refuses to start: it is connected as rasta_procurement_migrator, which is a migrator role \(rasta_procurement_migrator\).*can act as the owner of database rasta_procurement/,
    );
  });
});
