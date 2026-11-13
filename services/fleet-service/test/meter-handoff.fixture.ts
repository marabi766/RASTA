import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { readUrl } from '@rasta/config';
import { createSystemContext, OutboxRelay, runWithContext } from '@rasta/nest-common';
import { UsageService } from '../src/fleet/usage.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { recordUsageSchema } from '../src/fleet/dto';
import { MeterCertificateService } from '../src/fleet/meter-certificate';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { cleanup, databaseUrl, newPrisma, ownerDatabaseUrl } from './helpers';
import { PrismaClient } from '../src/generated/prisma';

// Separate fleet process: maintenance tests access only this test REST transport.
// Usage writes, certificate snapshots, claims, relay ACKs and DBs are production code.
if (process.env.NODE_ENV !== 'test') throw new Error('test fixture only');
Logger.overrideLogger(false);
// CI runs fleet and maintenance packages concurrently. A private fleet schema
// prevents either suite's global relay from claiming the other's outbox rows.
const schema = `meter_handoff_${randomUUID().replaceAll('-', '')}`;
const runtimeUrl = readUrl(databaseUrl());
const runtimeRole = decodeURIComponent(runtimeUrl.username).replaceAll('"', '""');
runtimeUrl.searchParams.set('schema', schema);
process.env.DATABASE_URL = runtimeUrl.toString();
const ownerUrl = readUrl(ownerDatabaseUrl());
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl.toString() } } });
ownerUrl.searchParams.set('schema', schema);
const prisma = newPrisma();
const usage = new UsageService(new FleetRepository(prisma));
const certificates = new MeterCertificateService(prisma);
const server = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      organizationId: string;
      assetId: string;
      deliveryUrl: string;
      record: unknown;
    };
    const { organizationId, assetId } = body;
    const result = await runWithContext(
      createSystemContext({
        organizationId,
        callerService: 'maintenance-service',
        correlationId: 'outbox-handoff-test',
      }),
      async () => {
        if (req.url === '/prepare')
          return prisma.client.assetRef.create({
            select: { id: true },
            data: {
              id: assetId,
              organizationId,
              status: 'ACTIVE',
              syncedAt: new Date(),
              sourceEvent: 'ITEST',
            },
          });
        if (req.url === '/record') return usage.record(recordUsageSchema.parse(body.record));
        if (req.url === '/certificate') return certificates.certificate({ assetId });
        if (req.url === '/reset') {
          await cleanup(prisma, [organizationId]);
          return {};
        }
        if (req.url === '/relay') {
          const delivered: unknown[] = [];
          const relay = new OutboxRelay({
            store: new PrismaOutboxStore(prisma),
            publisher: {
              async publish(rows) {
                for (const row of rows) {
                  const response = await fetch(body.deliveryUrl, {
                    method: 'POST',
                    body: JSON.stringify(row.payload),
                    signal: AbortSignal.timeout(10_000),
                  });
                  if (!response.ok) throw new Error('test delivery failed');
                  delivered.push(row.payload);
                }
              },
            },
          });
          try {
            for (let attempt = 0; attempt < 20; attempt++) {
              await relay.tick();
              if (
                (await prisma.client.outboxMessage.count({
                  where: { organizationId, publishedAt: null },
                })) === 0
              )
                break;
            }
          } finally {
            await relay.stop();
          }
          return {
            delivered,
            pending: await prisma.client.outboxMessage.count({
              where: { organizationId, publishedAt: null },
            }),
          };
        }
        throw new Error('unknown fixture operation');
      },
    );
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  })().catch((error: unknown) => {
    res.statusCode = 500;
    res.end(String(error));
  });
});
async function prepare(): Promise<void> {
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrated = spawnSync(
    process.execPath,
    [resolve(require.resolve('prisma/package.json'), '../build/index.js'), 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (migrated.status !== 0) throw new Error('isolated fleet migration failed');
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`,
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`,
  );
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string')
      process.send?.({ url: `http://127.0.0.1:${address.port}` });
  });
}
async function dispose(): Promise<void> {
  await prisma.stop();
  await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await owner.$disconnect();
}
void prepare().catch(async () => {
  await dispose();
  process.exitCode = 1;
});
process.on('disconnect', () => {
  server.close(() => {
    void dispose();
  });
});
