import { eventEnvelopeSchema } from '@rasta/contracts';
import { releaseWithin } from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { validateInventoryPayload, type InventoryEventName } from '../src/events/events';
import { client, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId } from './helpers';

/**
 * The transactional outbox (AGENTS.md A-08, ADR-021, ADR-050, ADR-051 B3; ADR-056 § 6): every
 * state change writes its event in the same transaction, with the platform envelope, a payload
 * that satisfies its published contract, and a stream sequence allocated inside that transaction
 * — one STRICT stream per stock item, consecutive from 1.
 */
describe('the transactional outbox', () => {
  let api: ApiHarness;
  let store: PrismaOutboxStore;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const outboxOf = (organizationId: string) =>
    api.prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    });

  beforeAll(async () => {
    api = await startApi();
    store = new PrismaOutboxStore(api.prisma);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  it('writes a valid envelope for every command, on rasta.inventory.v1, keyed by its stream', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    const { stockItemId, warehouseId } = await seedStock(api, a, 6);
    const first = (await owner.reserve([{ stockItemId, quantity: 2 }])).body.reservations[0].id;
    const second = (await owner.reserve([{ stockItemId, quantity: 1 }])).body.reservations[0].id;
    await owner.release(first);
    await owner.issue(second);
    await owner.adjust(stockItemId, -1);

    const rows = await outboxOf(a);
    expect(rows.map((row) => row.eventName)).toEqual([
      'WAREHOUSE_CREATED',
      'STOCK_RECEIVED',
      'STOCK_RESERVED',
      'STOCK_RESERVED',
      'STOCK_RELEASED',
      'STOCK_ISSUED',
      'STOCK_ADJUSTED',
    ]);
    for (const row of rows) {
      const envelope = eventEnvelopeSchema.parse(row.payload);
      expect(envelope).toMatchObject({
        producer: 'inventory-service',
        tenantId: a,
        eventName: row.eventName,
      });
      expect(() =>
        validateInventoryPayload(row.eventName as InventoryEventName, envelope.payload),
      ).not.toThrow();
      expect(row.topic).toBe('rasta.inventory.v1');
      expect(row.isStreamHead).toBe(false);
    }

    const [created, ...stock] = rows;
    expect(created).toMatchObject({
      aggregateType: 'Warehouse',
      partitionKey: warehouseId,
      streamSeq: 1n,
    });
    // The STRICT stock stream: one partition key, consecutive sequence numbers from 1, and the
    // payload's ledger position climbing with them.
    expect(stock.map((row) => row.partitionKey)).toEqual(Array(6).fill(stockItemId));
    expect(stock.map((row) => row.streamSeq)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(
      stock.map((row) => (row.payload as { payload: { itemVersion: number } }).payload.itemVersion),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('carries no warehouse name or location — identifiers, quantities and instants only', async () => {
    const a = org();
    const owner = client(api, orgAdmin(a));
    await owner.createWarehouse({
      name: 'Very identifiable name',
      location: { latitude: 35.7, longitude: 51.4 },
    });
    const [row] = await outboxOf(a);
    const text = JSON.stringify(row?.payload);
    expect(text).not.toContain('Very identifiable name');
    expect(text).not.toContain('35.7');
  });

  it('writes nothing when a command is refused', async () => {
    const a = org();
    const { stockItemId } = await seedStock(api, a, 1);
    const before = (await outboxOf(a)).length;
    expect((await client(api, orgAdmin(a)).reserve([{ stockItemId, quantity: 9 }])).status).toBe(
      422,
    );
    expect(await outboxOf(a)).toHaveLength(before);
  });

  it('can be claimed and acknowledged by the relay with a fencing token (ADR-050)', async () => {
    const a = org();
    await seedStock(api, a, 1);

    const claim = await store.claimPending({ limit: 1000, owner: 'test', leaseSeconds: 60 });
    const mine = claim.rows.filter((row) => row.organizationId === a).map((row) => row.id);
    const others = claim.rows.filter((row) => row.organizationId !== a).map((row) => row.id);
    expect(mine).toHaveLength(2);
    expect(await store.markPublished(mine, 'not-the-token')).toBe(0);
    expect(await store.markPublished(mine, claim.token as string)).toBe(2);
    if (others.length > 0) await store.release(others, claim.token as string, releaseWithin(5_000));
    expect((await outboxOf(a)).every((row) => row.publishedAt !== null)).toBe(true);
  });
});
