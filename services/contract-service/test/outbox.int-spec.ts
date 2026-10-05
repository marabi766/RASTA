import { eventEnvelopeSchema } from '@rasta/contracts';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { validateContractPayload } from '../src/events/events';
import { cleanup, newAward, newOrganizationId, tenderAwarded, wire, type Wiring } from './helpers';

/**
 * The transactional outbox (AGENTS.md A-08, ADR-021, ADR-050, ADR-051 B3): every row
 * carries the platform envelope with the event's correlation id, the tenant, a payload that
 * satisfies its published contract, and a stream sequence allocated inside the writing
 * transaction.
 */
describe('the transactional outbox', () => {
  let w: Wiring;
  let store: PrismaOutboxStore;
  const organizations: string[] = [];

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
    const award = newAward(organizationId);
    w.awards.serve(award);
    const event = tenderAwarded(award);
    await w.consumer.handle(event);
    return { award, event };
  }

  beforeAll(() => {
    w = wire();
    store = new PrismaOutboxStore(w.prisma);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });

  it('holds a valid envelope for the draft, in the draft’s tenant and stream', async () => {
    const a = org();
    const { award, event } = await draft(a);

    const [row] = await outboxOf(a);
    const envelope = eventEnvelopeSchema.parse(row?.payload);

    expect(envelope).toMatchObject({
      eventName: 'CONTRACT_DRAFTED',
      producer: 'contract-service',
      aggregateType: 'Contract',
      tenantId: a,
      causationId: event.eventId,
      correlationId: event.correlationId,
      streamKey: row?.aggregateId,
    });
    expect(() => validateContractPayload('CONTRACT_DRAFTED', envelope.payload)).not.toThrow();
    expect(envelope.payload).toMatchObject({ tenderId: award.tenderId, organizationId: a });
    expect(row).toMatchObject({
      topic: 'rasta.contract.v1',
      partitionKey: row?.aggregateId,
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
    if (others.length > 0) await store.release(others, claim.token as string);

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
    if (others.length > 0) await store.release(others, token);

    const rows = await outboxOf(a);
    const failedRow = rows.find((row) => row.id === failed)!;
    expect(failedRow).toMatchObject({ attempts: 1, lastError: 'broker down', publishedAt: null });
    expect(failedRow.nextAttemptAt).not.toBeNull();
    expect(await store.pendingCount()).toBeGreaterThanOrEqual(1);
    expect(await store.oldestPendingAgeSeconds()).toBeGreaterThanOrEqual(0);

    // Nothing published is older than the retention window yet, so nothing goes.
    const before = (await outboxOf(a)).length;
    await store.purgePublished(7);
    expect(await outboxOf(a)).toHaveLength(before);
    // With a zero-day window the published row goes and the failed one stays.
    await store.purgePublished(0);
    expect((await outboxOf(a)).map((row) => row.id)).toEqual([failed]);
  });
});
