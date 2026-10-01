import { randomUUID } from 'node:crypto';
import { OPS_REPLAY_TOPIC, REPLAY_EXECUTED, type EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { OpsReplayConsumer } from '../src/consumers/ops-replay.consumer';
import { OPS_REPLAY_CONSUMER, OpsReplayRejectedError } from '../src/audit/ops-replay.mapper';
import { cleanupRun, id, instantIn, newMigratorPrisma, newPrisma, runMonth } from './helpers';

/**
 * The replay record against real PostgreSQL: what one `REPLAY_EXECUTED`
 * becomes in the append-only store, under whose tenant, and what a refused one
 * leaves behind (nothing). `handle()` is driven directly, as
 * `trail-ingestion.int-spec.ts` does for path B; the broker half, published as
 * ops-replay, is `kafka-projector.int-spec.ts` `[retry-replay]`.
 */
describe('replay-record ingestion (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let consumer: OpsReplayConsumer;

  const DELIVERY: EventDelivery = Object.freeze({ topic: OPS_REPLAY_TOPIC, partition: 0 });
  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;

  /** A replay record for one replayed event; `tenant: null` for an event with none. */
  function record(tenant: string | null, occurredAt: string): EventEnvelope {
    const reportId = `rpl-${randomUUID()}`;
    const replayed = id('EVT');
    return {
      eventId: id('RPL'),
      eventName: REPLAY_EXECUTED,
      eventVersion: 1,
      occurredAt,
      producer: 'ops-replay',
      producerVersion: '1.0.0',
      aggregateType: 'ReplayRun',
      aggregateId: reportId,
      ...(tenant === null ? {} : { tenantId: tenant }),
      correlationId: reportId,
      causationId: replayed,
      actor: { type: 'USER', id: 'ops.itest' },
      payload: {
        reportId,
        operator: 'ops.itest',
        replayedEvent: {
          eventId: replayed,
          eventName: 'USAGE_RECORDED',
          ...(tenant === null ? {} : { tenantId: tenant }),
        },
        dlq: { topic: 'rasta.maintenance.v1.dlq', partition: 0, offset: '12' },
        target: { topic: 'rasta.fleet.v1.retry', partition: 1, offset: '40' },
        stale: 'UNKNOWN',
      },
    } as EventEnvelope;
  }

  const rowOf = (sourceEventId: string) =>
    prisma.client.auditEvent.findFirst({ where: { sourceEventId, sourceTopic: OPS_REPLAY_TOPIC } });
  const markersOf = (eventId: string) =>
    prisma.client.processedEvent.count({ where: { eventId, consumerName: OPS_REPLAY_CONSUMER } });

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    consumer = new OpsReplayConsumer(
      () => ({}) as EventConsumer,
      new AuditRepository(prisma),
      silentLogger,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 60_000);

  it('stores a replay under the replayed event’s tenant, chained, with its marker', async () => {
    const tenant = id('ORG');
    const source = record(tenant, instantIn(runMonth(1), 5).toISOString());

    await consumer.handle(source, DELIVERY);

    const row = await rowOf(source.eventId);
    const payload = source.payload as { reportId: string; replayedEvent: { eventId: string } };
    expect(row).toMatchObject({
      actorType: 'USER',
      actorId: 'ops.itest',
      organizationId: tenant,
      action: REPLAY_EXECUTED,
      resourceType: 'Event',
      resourceId: payload.replayedEvent.eventId,
      outcome: 'SUCCESS',
      sourceService: 'ops-replay',
      sourceTopic: OPS_REPLAY_TOPIC,
      correlationId: payload.reportId,
      changes: [
        { field: 'topic', from: 'rasta.maintenance.v1.dlq', to: 'rasta.fleet.v1.retry' },
        { field: 'partition', from: 0, to: 1 },
        { field: 'offset', from: '12', to: '40' },
        { field: 'eventName', from: null, to: 'USAGE_RECORDED' },
        { field: 'stale', from: null, to: 'UNKNOWN' },
      ],
    });
    // Chained like every row since AUD-003.
    expect(row?.recordHash).not.toBeNull();
    expect(await markersOf(source.eventId)).toBe(1);
  });

  it('keeps each tenant’s replay in that tenant alone, and an untenanted one on the platform', async () => {
    const [tenantA, tenantB] = [id('ORG'), id('ORG')];
    const month = runMonth(2);
    const forA = record(tenantA, instantIn(month, 1).toISOString());
    const forB = record(tenantB, instantIn(month, 2).toISOString());
    const platform = record(null, instantIn(month, 3).toISOString());
    for (const source of [forA, forB, platform]) await consumer.handle(source, DELIVERY);

    const inA = await prisma.client.auditEvent.findMany({
      where: { organizationId: tenantA, sourceTopic: OPS_REPLAY_TOPIC },
    });
    expect(inA.map((row) => row.sourceEventId)).toEqual([forA.eventId]);
    const inB = await prisma.client.auditEvent.findMany({
      where: { organizationId: tenantB, sourceTopic: OPS_REPLAY_TOPIC },
    });
    expect(inB.map((row) => row.sourceEventId)).toEqual([forB.eventId]);
    // The platform record belongs to no tenant (ADR-053 § 10: SYSTEM_ADMIN only).
    expect((await rowOf(platform.eventId))?.organizationId).toBeNull();
  });

  it('writes one row for a record delivered twice', async () => {
    const source = record(id('ORG'), instantIn(runMonth(3), 1).toISOString());

    await consumer.handle(source, DELIVERY);
    await consumer.handle(source, DELIVERY);

    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: source.eventId } })).toBe(
      1,
    );
    expect(await markersOf(source.eventId)).toBe(1);
  });

  it('refuses a record whose tenant disagrees with itself, and leaves nothing behind', async () => {
    const source = record(id('ORG'), instantIn(runMonth(4), 1).toISOString());
    const disagreeing = { ...source, tenantId: id('ORG') } as EventEnvelope;

    await expect(consumer.handle(disagreeing, DELIVERY)).rejects.toThrow(OpsReplayRejectedError);

    expect(await rowOf(source.eventId)).toBeNull();
    expect(await markersOf(source.eventId)).toBe(0);
  });
});
