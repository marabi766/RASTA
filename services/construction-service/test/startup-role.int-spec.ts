import { migratorCredentialsIn, withUtcSession } from '@rasta/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

/**
 * construction-service refuses to start as anything but its runtime role (D-045,
 * Codex review of #176).
 *
 * `assertNoMigratorCredentials` (main.ts) keeps every `*_MIGRATOR` variable out
 * of the service's environment, but a `DATABASE_URL` that simply names the
 * migrator carries no such variable and would pass it. So `AppModule` first
 * asks the catalogue who the connection really is
 * (`PrismaService.assertRuntimeRole`, @rasta/nest-common runtime-role.ts) and
 * stops before it serves, relays or consumes anything.
 */
function migratorUrl(): string {
  const url = process.env.DATABASE_URL_CONSTRUCTION_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_CONSTRUCTION_MIGRATOR is not set; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

describe('construction-service starts only as its runtime role (D-045)', () => {
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
    // The environment guard has nothing to see: only DATABASE_URL is set…
    expect(migratorCredentialsIn({ DATABASE_URL: migratorUrl() })).toEqual([]);
    // …so the connected role is what stops it, by name and by what it owns.
    await expect(open(migratorUrl()).assertRuntimeRole()).rejects.toThrow(
      /construction-service refuses to start: it is connected as rasta_construction_migrator, which is a migrator role \(rasta_construction_migrator\).*can act as the owner of database rasta_construction/,
    );
  });
});
