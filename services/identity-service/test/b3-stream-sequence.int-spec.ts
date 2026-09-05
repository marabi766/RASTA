import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IDENTITY_EVENTS } from '../src/identity/events';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * ADR-051 Phase B3 in this service, against a real database.
 *
 * The shared protocol suite (`pnpm test:outbox-b3`) proves the allocator. This
 * proves *identity* uses it: an outbox write commits a row whose persisted
 * `stream_seq`, envelope `streamSeq`, envelope `streamKey` and `x-stream-seq`
 * header all agree, keyed by the stream this service's own `routing.ts` chose.
 *
 * **What this drives, and what it does not.** It calls
 * `IdentityRepository.enqueueEvent` inside a real `repository.transaction` —
 * which is the entire production event path for this service: the routing
 * policy, the allocation against `(topic, partitionKey)`, and the insert. What
 * it does not drive is `IdentityService`, because constructing that needs a
 * live `KeycloakAdminClient`, and standing one up is a larger change than B3.
 * The distinction is recorded rather than glossed: the sequencing path is real
 * and exercised end to end; the surrounding user-registration workflow is not.
 */
describe('identity stream sequencing', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: IdentityRepository;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new IdentityRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const assertConsistent = (row: {
    partitionKey: string;
    streamSeq: bigint | null;
    payload: unknown;
    headers: unknown;
  }): number => {
    const envelope = row.payload as { streamSeq?: number; streamKey?: string };
    const headers = row.headers as Record<string, string>;

    expect(row.streamSeq).not.toBeNull();
    const persisted = Number(row.streamSeq);
    expect(envelope.streamSeq).toBe(persisted);
    expect(envelope.streamKey).toBe(row.partitionKey);
    expect(headers['x-stream-seq']).toBe(String(persisted));
    return persisted;
  };

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('sequences an event on the aggregate stream and continues it', async () => {
    const userId = id('USR-B3');

    await asActor({ organizationId: org.a }, () =>
      repository.transaction(async (tx) => {
        await repository.enqueueEvent(tx, {
          aggregateType: 'User',
          aggregateId: userId,
          eventName: IDENTITY_EVENTS.USER_REGISTERED,
          topic: 'rasta.identity.v1',
          organizationId: org.a,
          payload: {
            userId,
            username: `b3-${userId.slice(-8)}`,
            requestedOrganizationId: org.a,
            requestedRoles: ['ORG_USER'],
          },
        });
        await repository.enqueueEvent(tx, {
          aggregateType: 'User',
          aggregateId: userId,
          eventName: IDENTITY_EVENTS.USER_ACTIVATED,
          topic: 'rasta.identity.v1',
          organizationId: org.a,
          payload: { userId, organizationId: org.a },
        });
      }),
    );

    const rows = await outboxFor(userId);
    expect(rows.map((row) => row.eventName)).toEqual(['USER_REGISTERED', 'USER_ACTIVATED']);

    for (const row of rows) {
      expect(row.topic).toBe('rasta.identity.v1');
      // Aggregate-scoped, now stated in `routing.ts` rather than left to the
      // `buildOutboxRow` default.
      expect(row.partitionKey).toBe(userId);
      assertConsistent(row);
    }

    // Two events in one transaction, numbered 1 then 2 with no gap: the
    // counter advanced once per event, not once per transaction.
    expect(rows.map((row) => Number(row.streamSeq))).toEqual([1, 2]);

    // The counter is this service's own, positioned for the next allocation,
    // and `published_seq` has not moved — advancing it is B4.
    const counters = await runUnscoped('reads platform plumbing', () =>
      prisma.client.$queryRawUnsafe<{ topic: string; next_seq: bigint; published_seq: bigint }[]>(
        `SELECT "topic", "next_seq", "published_seq"
           FROM "outbox_stream_sequence" WHERE "partition_key" = $1`,
        userId,
      ),
    );
    expect(counters).toHaveLength(1);
    expect(counters[0].topic).toBe('rasta.identity.v1');
    expect(Number(counters[0].next_seq)).toBe(3);
    expect(Number(counters[0].published_seq)).toBe(0);
  });

  it('rolls the counter back with a failed transaction, leaving no gap', async () => {
    const userId = id('USR-B3R');

    await asActor({ organizationId: org.a }, () =>
      repository.transaction((tx) =>
        repository.enqueueEvent(tx, {
          aggregateType: 'User',
          aggregateId: userId,
          eventName: IDENTITY_EVENTS.USER_REGISTERED,
          topic: 'rasta.identity.v1',
          organizationId: org.a,
          payload: {
            userId,
            username: `b3-${userId.slice(-8)}`,
            requestedOrganizationId: org.a,
            requestedRoles: ['ORG_USER'],
          },
        }),
      ),
    );

    // A domain failure after allocation must give the number back.
    await expect(
      asActor({ organizationId: org.a }, () =>
        repository.transaction(async (tx) => {
          await repository.enqueueEvent(tx, {
            aggregateType: 'User',
            aggregateId: userId,
            eventName: IDENTITY_EVENTS.USER_SUSPENDED,
            topic: 'rasta.identity.v1',
            organizationId: org.a,
            payload: { userId, organizationId: org.a, reason: 'B3 rollback evidence' },
          });
          throw new Error('domain rule violated');
        }),
      ),
    ).rejects.toThrow('domain rule violated');

    const afterRollback = await outboxFor(userId);
    expect(afterRollback).toHaveLength(1);

    // The next committed event takes the number the rollback returned, so the
    // stream has no gap — the property a BIGSERIAL cannot offer.
    await asActor({ organizationId: org.a }, () =>
      repository.transaction((tx) =>
        repository.enqueueEvent(tx, {
          aggregateType: 'User',
          aggregateId: userId,
          eventName: IDENTITY_EVENTS.USER_ACTIVATED,
          topic: 'rasta.identity.v1',
          organizationId: org.a,
          payload: { userId, organizationId: org.a },
        }),
      ),
    );

    const rows = await outboxFor(userId);
    expect(rows.map((row) => Number(row.streamSeq))).toEqual([1, 2]);
  });
});
