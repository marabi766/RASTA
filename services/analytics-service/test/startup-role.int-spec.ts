import { migratorCredentialsIn } from '@rasta/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, ownerDatabaseUrl } from './helpers';

/**
 * analytics-service refuses to start as anything but its runtime role (D-045,
 * `docs/runbooks/db-role-split.md` § 7.5).
 *
 * `assertNoMigratorCredentials` (main.ts) keeps every `*_MIGRATOR` variable out of the service's
 * environment, but a `DATABASE_URL` that simply names the migrator carries no such variable and
 * would pass it. So `AppModule` first asks the catalogue who the connection really is
 * (`PrismaService.assertRuntimeRole`) and stops before it serves or projects anything — a
 * projection run as the owner could lift the append-only trigger it relies on.
 */
describe('analytics-service starts only as its runtime role (D-045)', () => {
  const opened: PrismaService[] = [];
  const open = (url: string) => {
    const prisma = new PrismaService(url);
    opened.push(prisma);
    return prisma;
  };

  afterAll(async () => {
    await Promise.all(opened.map((prisma) => prisma.disconnect()));
  });

  it('accepts the runtime role', async () => {
    await expect(open(databaseUrl()).assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('refuses a DATABASE_URL that names the migrator, which no *_MIGRATOR variable reveals', async () => {
    expect(migratorCredentialsIn({ DATABASE_URL: ownerDatabaseUrl() })).toEqual([]);
    await expect(open(ownerDatabaseUrl()).assertRuntimeRole()).rejects.toThrow(
      /analytics-service refuses to start: it is connected as rasta_analytics_migrator, which is a migrator role/,
    );
  });
});
