import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { ConcludedOutcomeRepository } from '../src/performance/concluded-outcome.repository';
import { PerformanceEventRepository } from '../src/performance/performance-event.repository';
import { PERFORMANCE_CONSUMER, PerformanceConsumer } from '../src/performance/performance.consumer';
import { PrismaService } from '../src/prisma/prisma.service';
import { newOrganizationId } from './helpers';

/**
 * `20260926140000_performance_consumer_facts` rolled back **with data in it**,
 * re-applied, and replayed (Codex review of #126, finding 3).
 *
 * The reversibility verifier proves the schema round-trips on an empty
 * database. This proves the rows and the markers do: after `down.sql` no
 * `processed_event` marker claims an effect that is gone, so a replay after
 * `up` records every removed effect again — and nothing else twice.
 *
 * Everything runs in a throwaway schema made by the database's owner, through
 * the real Prisma CLI and the real consumer, and is dropped at the end.
 */

const MIGRATION = '20260926140000_performance_consumer_facts';
const SERVICE_DIR = join(__dirname, '..');

const PRISMA_CLI = (() => {
  const require = createRequire(join(SERVICE_DIR, 'package.json'));
  return join(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
})();

function prismaCli(argv: string[], options: { url: string; stdin?: string }): void {
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...argv], {
    cwd: SERVICE_DIR,
    env: { ...process.env, DATABASE_URL: options.url },
    input: options.stdin,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma ${argv.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
}

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

describe(`${MIGRATION}: rollback with data, then re-apply and replay`, () => {
  const ownerUrl = process.env.DATABASE_URL_SUPPLIER_MIGRATOR;
  const schema = `rollback_${ulid().toLowerCase()}`;
  let scratchUrl: string;
  let owner: PrismaService;
  let scratch: PrismaService;
  let consumer: PerformanceConsumer;

  beforeAll(async () => {
    if (!ownerUrl)
      throw new Error('DATABASE_URL_SUPPLIER_MIGRATOR is not set; see .env.migrator.example');
    const url = new URL(ownerUrl);
    url.searchParams.set('schema', schema);
    scratchUrl = url.toString();

    owner = new PrismaService(ownerUrl);
    await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    prismaCli(['migrate', 'deploy'], { url: scratchUrl });

    scratch = new PrismaService(scratchUrl);
    consumer = new PerformanceConsumer(
      null,
      scratch,
      new PerformanceEventRepository(scratch),
      new ConcludedOutcomeRepository(scratch),
      silent,
    );
  }, 240_000);

  afterAll(async () => {
    await scratch?.onModuleDestroy();
    await owner?.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner?.onModuleDestroy();
  }, 60_000);

  const buyer = newOrganizationId();
  const supplier = newOrganizationId();
  const orderId = `ORD_${ulid()}`;

  function envelope(eventName: string, payload: Record<string, unknown>): EventEnvelope {
    return {
      eventId: `EVT_${ulid()}`,
      eventName,
      eventVersion: 1,
      occurredAt: '2026-09-28T08:00:00.000Z',
      producer: 'marketplace-service',
      producerVersion: '1.0.0',
      aggregateType: 'Order',
      aggregateId: orderId,
      tenantId: buyer,
      correlationId: `COR_${ulid()}`,
      payload: {
        orderId,
        buyerOrganizationId: buyer,
        supplierOrganizationId: supplier,
        ...payload,
      },
    };
  }

  const dispute = envelope('ORDER_DISPUTE_RESOLVED', {
    disputeId: `DSP_${ulid()}`,
    responsibility: 'SUPPLIER',
  });
  const completed = envelope('ORDER_COMPLETED', {});
  const review = envelope('REVIEW_SUBMITTED', { rating: 4 });
  const all = [dispute, completed, review];

  async function state() {
    return runUnscoped('test: the scratch schema, read whole', async () => {
      const markers = await scratch.client.processedEvent.findMany({
        where: { consumerName: PERFORMANCE_CONSUMER },
        select: { eventId: true },
      });
      const facts = await scratch.client.$queryRawUnsafe<{ source_event_id: string }[]>(
        'SELECT "source_event_id" FROM "performance_event"',
      );
      const outcomes = await scratch.client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'performance_concluded_outcome'`,
      );
      return {
        markers: markers.map((row) => row.eventId).sort(),
        facts: facts.map((row) => row.source_event_id).sort(),
        outcomeTable: Number(outcomes[0]?.n ?? 0) === 1,
      };
    });
  }

  it('records, rolls back coherently, re-applies, and replays every removed effect', async () => {
    for (const source of all) await consumer.handle(source);
    expect(await state()).toEqual({
      markers: [completed.eventId, dispute.eventId, review.eventId].sort(),
      facts: [dispute.eventId, review.eventId].sort(),
      outcomeTable: true,
    });

    // Down, with data in it.
    prismaCli(['db', 'execute', '--url', scratchUrl, '--stdin'], {
      url: scratchUrl,
      stdin: readFileSync(join(SERVICE_DIR, 'prisma', 'migrations', MIGRATION, 'down.sql'), 'utf8'),
    });

    // The concluded outcome and the dispute fact are gone, and so are their
    // markers. The review — a fact this migration did not reshape — and its
    // marker are untouched.
    expect(await state()).toEqual({
      markers: [review.eventId],
      facts: [review.eventId],
      outcomeTable: false,
    });

    // Up again, and replay the whole history.
    prismaCli(['migrate', 'deploy'], { url: scratchUrl });
    await scratch.onModuleDestroy();
    scratch = new PrismaService(scratchUrl);
    consumer = new PerformanceConsumer(
      null,
      scratch,
      new PerformanceEventRepository(scratch),
      new ConcludedOutcomeRepository(scratch),
      silent,
    );
    for (const source of all) await consumer.handle(source);

    expect(await state()).toEqual({
      markers: [completed.eventId, dispute.eventId, review.eventId].sort(),
      facts: [dispute.eventId, review.eventId].sort(),
      outcomeTable: true,
    });
    const restored = await runUnscoped('test: the replayed dispute fact', () =>
      scratch.client.performanceEvent.findUnique({ where: { sourceEventId: dispute.eventId } }),
    );
    expect(restored?.disputeId).toBe((dispute.payload as { disputeId: string }).disputeId);
    expect(
      await runUnscoped('test: the replayed outcome', () =>
        scratch.client.performanceConcludedOutcome.count({
          where: { sourceEventId: completed.eventId },
        }),
      ),
    ).toBe(1);
  }, 240_000);
});
