import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { OutboxRelay, type EventPublisher, type OutboxRow } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { flushOutbox } from '../src/outbox/flush.command';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { PrismaService } from '../src/prisma/prisma.service';
import { newPrisma, tenants } from './helpers';

/**
 * `outbox:flush` (#240 round 5) with the service's real store and relay over a
 * real PostgreSQL, and a publisher that records instead of reaching a broker.
 *
 * The database is shared with other suites; the flush publishes whatever is
 * claimable, as it does in operation, so every assertion about rows is about
 * this suite's own organization.
 */
describe('outbox:flush (#240 r5)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let store: PrismaOutboxStore;

  const queue = async (): Promise<string> => {
    const id = ulid();
    await prisma.client.$executeRaw`
      INSERT INTO outbox_message (id, aggregate_type, aggregate_id, event_name, topic,
                                  partition_key, payload, headers, correlation_id, organization_id)
      VALUES (${id}, 'InsurancePolicy', ${id}, 'INSURANCE_RECORDED', 'rasta.insurance.v1',
              ${id}, '{}'::jsonb, '{}'::jsonb, ${id}, ${org.a})`;
    return id;
  };

  const mine = async (): Promise<number> => {
    const rows = await prisma.client.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox_message
       WHERE organization_id = ${org.a} AND published_at IS NULL`;
    return rows[0]!.n;
  };

  function relayWith(publisher: EventPublisher): OutboxRelay {
    return new OutboxRelay({
      store,
      publisher,
      batchSize: 50,
      leaseSeconds: 30,
      backoff: { baseSeconds: 1, maxSeconds: 2 },
      shutdownGraceSeconds: 1,
    });
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    store = new PrismaOutboxStore(prisma);
  });

  afterAll(async () => {
    await prisma.client.$executeRaw`DELETE FROM outbox_message WHERE organization_id = ${org.a}`;
    await prisma.onModuleDestroy();
  });

  it('publishes unpublished rows and ends with none left, opening no listener', async () => {
    const ids = [await queue(), await queue(), await queue()];
    expect(await mine()).toBe(3);

    const seen: string[] = [];
    const listen = jest.spyOn(net.Server.prototype, 'listen');
    const relay = relayWith({
      publish: async (rows: readonly OutboxRow[]) => {
        seen.push(...rows.map((r) => r.id));
      },
    });
    try {
      const report = await flushOutbox({
        tick: () => relay.tick(),
        unpublished: () => store.pendingCount(),
        maxSeconds: 60,
        pollMs: 200,
      });

      expect(report).toMatchObject({ drained: true, timedOut: false, unpublished: 0 });
      expect(seen).toEqual(expect.arrayContaining(ids));
      expect(await mine()).toBe(0);
      expect(await store.pendingCount()).toBe(0);
      // What can be asserted of "no HTTP server": nothing bound a socket.
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
      await relay.stop();
    }
  });

  it('times out, and is not drained, while the broker keeps refusing', async () => {
    await queue();
    const relay = relayWith({
      publish: async () => {
        throw new Error('broker down');
      },
    });
    try {
      const report = await flushOutbox({
        tick: () => relay.tick(),
        unpublished: () => store.pendingCount(),
        maxSeconds: 2,
        pollMs: 200,
      });
      expect(report).toMatchObject({ drained: false, timedOut: true });
      expect(report.unpublished).toBeGreaterThanOrEqual(1);
      expect(await mine()).toBe(1);
    } finally {
      await relay.stop();
    }
  });

  it('the command starts no server, consumer, sweep or timer: its sources import none', () => {
    // The other half of "no other writers": the entry point is built from the
    // store, the publisher and the relay's tick(), not from the application.
    const dir = join(__dirname, '..', 'src', 'outbox');
    const source = ['flush.cli.ts', 'flush.command.ts']
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      // Comments explain what it avoids; only code is judged.
      .map((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
    for (const forbidden of [
      /NestFactory/,
      /AppModule/,
      /@nestjs\//,
      /EventConsumer/,
      /runExpirySweep/,
      /purgeExpired/,
      /\.start\(\)/,
      /setInterval/,
      /\.listen\(/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
