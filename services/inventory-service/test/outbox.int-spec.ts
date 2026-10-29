import { eventEnvelopeSchema } from '@rasta/contracts';
import { releaseWithin } from '@rasta/nest-common';
import { ISO_INSTANT_SHAPE, envelopeShape, expectStoredMessageWithout } from '@rasta/testing';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { validateInventoryPayload, type InventoryEventName } from '../src/events/events';
import { actor, client, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
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
    const creator = 'USR-APITEST-OUTBOX';
    const owner = client(api, actor(a, ['ORGANIZATION_ADMIN'], { rastaUserId: creator }));
    const name = 'Very identifiable name';
    const location = { latitude: 35.689197, longitude: 51.388974 };
    const created = await owner.createWarehouse({ name, location });
    expect(created.status).toBe(201);

    // The one event this command wrote — never an empty list read as "nothing disclosed".
    const rows = await outboxOf(a);
    expect(rows.map((row) => row.eventName)).toEqual(['WAREHOUSE_CREATED']);
    const envelope = eventEnvelopeSchema.parse(rows[0]?.payload);

    // The exact allowed fields, with the values they must hold. Nothing else may be there, so no
    // name, no coordinate, rounded or not, and no new field can pass unseen. The schema is strict
    // too (events.ts warehouseCreatedPayload); this pins the contract independently of it.
    expect(envelope.payload).toEqual({
      warehouseId: created.body.id,
      organizationId: a,
      createdBy: creator,
      createdAt: expect.stringMatching(ISO_INSTANT_SHAPE),
    });

    // The whole stored message, envelope included, pinned and searched at every depth: the exact
    // shape (an unknown key anywhere, `actor` too, is a failure; only `occurredAt` and `createdAt`
    // are exempt from the search, and must hold a strict instant), and the name and both
    // coordinates nowhere in it — as a value, part of one, a property NAME, or a number written
    // another way — and no number or decimal word within 0.5 of either coordinate, so a rounded
    // one fails too. Envelope parsing strips an unknown key, so only the raw row shows it. Never
    // as a substring of its JSON: that text carries ULIDs and instants, and a short coordinate
    // such as "35.7" occurs inside "…:35.712Z" about one run in 600 (train run 40130819112).
    expectStoredMessageWithout(rows[0]?.payload, {
      anywhere: [name, String(location.latitude), String(location.longitude)],
      numbers: [location.latitude, location.longitude],
      near: { values: [location.latitude, location.longitude], within: 0.5 },
      shape: envelopeShape({
        warehouseId: 'string',
        organizationId: 'string',
        createdBy: 'string',
        createdAt: 'instant',
      }),
    });
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
