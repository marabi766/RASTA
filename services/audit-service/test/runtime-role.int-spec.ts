import { PrismaService } from '../src/prisma/prisma.service';
import { migratorUrl, runtimeUrl } from './helpers';

/**
 * The startup check that keeps the migrator's connection out of the running
 * service (ADR-053 § 6), against the real roles the bootstrap creates.
 *
 * The env loader already reads only DATABASE_URL_AUDIT; this is the second
 * line, which asks PostgreSQL who the connection actually is — so a
 * DATABASE_URL_AUDIT that was pointed at the migrator by mistake still stops
 * the service before it consumes or serves anything.
 */
describe('audit-service refuses to run as a role that owns the audit schema', () => {
  const clients: PrismaService[] = [];
  const open = async (url: string) => {
    const client = new PrismaService(url);
    clients.push(client);
    await client.onModuleInit();
    return client;
  };

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.onModuleDestroy()));
  });

  it('accepts the runtime role', async () => {
    const runtime = await open(runtimeUrl());
    await expect(runtime.assertRuntimeRole()).resolves.toBeUndefined();
  });

  it('refuses the migrator, naming it', async () => {
    const migrator = await open(migratorUrl());
    await expect(migrator.assertRuntimeRole()).rejects.toThrow(
      /refuses to start: it is connected as rasta_audit_migrator, which can act as the owner of schema audit/,
    );
  });
});
