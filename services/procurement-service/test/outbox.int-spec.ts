import { eventEnvelopeSchema } from '@rasta/contracts';
import { releaseWithin } from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { validateProcurementPayload } from '../src/events/events';
import { buyer, client, startApi, type ApiHarness } from './api-helpers';
import { ulid } from 'ulid';
import { cleanup, newOrganizationId } from './helpers';

/**
 * The transactional outbox (AGENTS.md A-08, ADR-021, ADR-050, ADR-051 B3): every row
 * carries the platform envelope with the request's correlation id, the tenant, a payload that
 * satisfies its published contract, and a stream sequence allocated inside the writing
 * transaction.
 */
describe('the transactional outbox', () => {
  let api: ApiHarness;
  let store: PrismaOutboxStore;
  const organizations: string[] = [];
  const w = {
    get prisma() {
      return api.prisma;
    },
  };

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const outboxOf = (organizationId: string) =>
    w.prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });

  async function draft(organizationId: string) {
    const correlationId = ulid();
    const response = await client(api, buyer(organizationId))
      .submit({ quantity: 2 })
      .set('x-correlation-id', correlationId);
    expect(response.status).toBe(201);
    return { ...(response.body as { id: string; aggregationId: string }), correlationId };
  }

  beforeAll(async () => {
    api = await startApi();
    store = new PrismaOutboxStore(api.prisma);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  it('holds a valid envelope for the demand, in the buyer’s tenant and the window’s stream', async () => {
    const a = org();
    const demand = await draft(a);

    const [row] = await outboxOf(a);
    const envelope = eventEnvelopeSchema.parse(row?.payload);

    expect(envelope).toMatchObject({
      eventName: 'DEMAND_SUBMITTED',
      producer: 'procurement-service',
      aggregateType: 'DemandRequest',
      aggregateId: demand.id,
      tenantId: a,
      correlationId: demand.correlationId,
      streamKey: demand.aggregationId,
    });
    expect(() => validateProcurementPayload('DEMAND_SUBMITTED', envelope.payload)).not.toThrow();
    expect(envelope.payload).toMatchObject({ demandId: demand.id, organizationId: a });
    expect(row).toMatchObject({
      topic: 'rasta.procurement.v1',
      partitionKey: demand.aggregationId,
      streamSeq: 1n,
      isStreamHead: false,
      publishedAt: null,
    });
  });

  it('can be claimed and acknowledged by the relay with a fencing token (ADR-050)', async () => {
    const a = org();
    await draft(a);

    const claim = await store.claimPending({ limit: 500, owner: 'test', leaseSeconds: 60 });
    const mine = claim.rows.filter((row) => row.organizationId === a).map((row) => row.id);
    const others = claim.rows.filter((row) => row.organizationId !== a).map((row) => row.id);
    expect(mine).toHaveLength(1);

    expect(await store.markPublished(mine, 'not-the-token')).toBe(0);
    expect(await store.markPublished(mine, claim.token as string)).toBe(1);
    if (others.length > 0) await store.release(others, claim.token as string, releaseWithin(5_000));

    const [row] = await outboxOf(a);
    expect(row?.publishedAt).not.toBeNull();
  });

  it('records a failure with backoff, renews a live lease, and purges only published rows', async () => {
    const a = org();
    await draft(a);
    await draft(a);

    const claim = await store.claimPending({ limit: 500, owner: 'test', leaseSeconds: 60 });
    const token = claim.token as string;
    const mine = claim.rows.filter((row) => row.organizationId === a).map((row) => row.id);
    const others = claim.rows.filter((row) => row.organizationId !== a).map((row) => row.id);
    expect(mine).toHaveLength(2);
    expect(await store.activeLeaseCount()).toBeGreaterThanOrEqual(2);

    const renewed = await store.renew(mine, token, 60, 5_000);
    expect([...renewed].sort()).toEqual([...mine].sort());

    const [failed, published] = mine as [string, string];
    expect(
      await store.markFailed(failed, token, 'broker down', { baseSeconds: 5, maxSeconds: 60 }),
    ).toBe(1);
    expect(await store.markPublished([published], token)).toBe(1);
    if (others.length > 0) await store.release(others, token, releaseWithin(5_000));

    const rows = await outboxOf(a);
    const failedRow = rows.find((row) => row.id === failed)!;
    expect(failedRow).toMatchObject({ attempts: 1, lastError: 'broker down', publishedAt: null });
    expect(failedRow.nextAttemptAt).not.toBeNull();
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(1);
    expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(0);

    // One bounded batch, as `OutboxPurgeScheduler` issues it (D-052). The isolated proof of what
    // the purge keeps is `outbox-purge.int-spec.ts`.
    const purge = () =>
      store.purgePublished({
        retentionSeconds: 7 * 24 * 60 * 60,
        limit: 10_000,
        statementTimeoutMs: 5000,
        maxWaitMs: 2000,
      });
    // Nothing published is older than the retention window yet, so nothing goes.
    const before = (await outboxOf(a)).length;
    await purge();
    expect(await outboxOf(a)).toHaveLength(before);
    // Published past the window, the published row goes and the failed one stays.
    await w.prisma.client.$executeRaw`
      UPDATE outbox_message
         SET created_at = now() - interval '30 days',
             published_at = now() - interval '30 days' + interval '1 second'
       WHERE id = ${published}`;
    await purge();
    expect((await outboxOf(a)).map((row) => row.id)).toEqual([failed]);
  });
});
