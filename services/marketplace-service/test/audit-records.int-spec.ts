import { ulid } from 'ulid';
import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  outboxFor,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * State changes that used to publish nothing are audited (AGENTS.md S-06,
 * global audit L7-14), against a real PostgreSQL.
 *
 * Two families: the catalogue's own writes (a product, a draft offer, an
 * offer taken out of publication), made by a supplier's user; and the order
 * saga's internal transitions, made by this service with no user behind them.
 * Each commits exactly one event in the transaction of the change, carries the
 * actor the request context named and is filed under the tenant that owns
 * the row — and a rollback takes the change and the event together.
 */
describe('L7-14 audit records (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-AUDIT-SUP' }, fn);
  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor(
      { organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-AUDIT-BUY' },
      fn,
    );
  /**
   * The context `activities.ts` establishes: a system context with this
   * service as caller and the buyer's organization — and no user, which is
   * what makes the envelope's actor the service.
   */
  const asSaga = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({
        correlationId: `COR-${ulid()}`,
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
        organizationId: org.buyer,
      }),
      fn,
    );

  type Envelope = {
    tenantId?: string;
    actor?: { type: string; id: string };
    aggregateType: string;
    payload: Record<string, unknown>;
  };

  const eventsAbout = async (organizationId: string, aggregateId: string, eventName: string) =>
    (await outboxFor(prisma, organizationId)).filter(
      (row) => row.aggregateId === aggregateId && row.eventName === eventName,
    );

  /** Makes the next enqueue fail *after* its outbox insert, inside the same transaction. */
  function failAfterInsert() {
    const original = wiring.events.enqueue.bind(wiring.events);
    return jest.spyOn(wiring.events, 'enqueue').mockImplementationOnce(async (tx, input) => {
      await original(tx, input);
      throw new Error('failure after the outbox insert');
    });
  }

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------

  it('records a product, a draft and a withdrawal once each, with the supplier’s user as actor', async () => {
    const product = await asSupplier(() =>
      wiring.catalogue.createProduct({
        sku: `SKU-AUD-${ulid().slice(-8)}`,
        name: 'فیلتر هوا',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      }),
    );
    const draft = await asSupplier(() =>
      wiring.catalogue.createOffer({
        productId: product.id,
        unitPriceMinor: '120000',
        currency: 'IRR',
        availableQuantity: 5,
        leadTimeDays: 2,
        minimumQuantity: 1,
        publish: false,
      }),
    );
    const { offerId } = await publishOffer(wiring, org.supplier);
    await asSupplier(() => wiring.catalogue.updateOffer(offerId, { status: 'WITHDRAWN' }));

    const cases: Array<[string, string, string]> = [
      [product.id, 'PRODUCT_CREATED', 'Product'],
      [draft.id, 'OFFER_DRAFTED', 'Offer'],
      [offerId, 'OFFER_UPDATED', 'Offer'],
    ];
    for (const [aggregateId, eventName, aggregateType] of cases) {
      const rows = await eventsAbout(org.supplier, aggregateId, eventName);
      expect({ eventName, count: rows.length }).toEqual({ eventName, count: 1 });
      const envelope = rows[0].payload as Envelope;
      expect(rows[0].topic).toBe('rasta.marketplace.v1');
      expect(rows[0].partitionKey).toBe(aggregateId);
      expect(envelope.tenantId).toBe(org.supplier);
      expect(envelope.actor).toEqual({ type: 'USER', id: 'USR-AUDIT-SUP' });
      expect(envelope.aggregateType).toBe(aggregateType);
    }

    const [withdrawn] = await eventsAbout(org.supplier, offerId, 'OFFER_UPDATED');
    expect((withdrawn.payload as Envelope).payload).toMatchObject({
      previousStatus: 'PUBLISHED',
      status: 'WITHDRAWN',
      changedFields: ['status'],
    });
    // The product's display text stays in the catalogue, not on the wire.
    expect(
      JSON.stringify((await eventsAbout(org.supplier, product.id, 'PRODUCT_CREATED'))[0].payload),
    ).not.toContain('فیلتر هوا');
  });

  it('rolls a product and its event back together', async () => {
    const sku = `SKU-AUD-RB-${ulid().slice(-8)}`;
    const spy = failAfterInsert();

    try {
      await expect(
        asSupplier(() =>
          wiring.catalogue.createProduct({
            sku,
            name: 'x',
            category: 'PARTS',
            kind: 'GOOD',
            unit: 'عدد',
          }),
        ),
      ).rejects.toThrow('failure after the outbox insert');
    } finally {
      spy.mockRestore();
    }

    const left = await runUnscoped('assertions read the rows directly', () =>
      prisma.client.product.findMany({ where: { sku } }),
    );
    expect(left).toEqual([]);
    const events = (await outboxFor(prisma, org.supplier)).filter(
      (row) => (row.payload as Envelope).payload.sku === sku,
    );
    expect(events).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The saga
  // -------------------------------------------------------------------------

  async function pendingOrder() {
    const { offerId } = await publishOffer(wiring, org.supplier);
    return asBuyer(() => wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('ord')));
  }

  it('records the funds hold under the buyer, with this service as actor, and nowhere else', async () => {
    const order = await pendingOrder();

    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN-${ulid()}`));

    const rows = await eventsAbout(org.buyer, order.id, 'ORDER_FUNDS_HELD');
    expect(rows).toHaveLength(1);
    const envelope = rows[0].payload as Envelope;
    expect(rows[0].partitionKey).toBe(order.id);
    expect(envelope.tenantId).toBe(org.buyer);
    expect(envelope.actor).toEqual({ type: 'SERVICE', id: 'marketplace-service' });
    expect(envelope.payload).toMatchObject({
      orderId: order.id,
      buyerOrganizationId: org.buyer,
      supplierOrganizationId: org.supplier,
      status: 'FUNDS_HELD',
    });

    // Tenant isolation: the supplier is a party to the order, but the
    // saga's record is the buyer's, like every order event.
    expect(await eventsAbout(org.supplier, order.id, 'ORDER_FUNDS_HELD')).toEqual([]);
    expect(await eventsAbout(org.other, order.id, 'ORDER_FUNDS_HELD')).toEqual([]);

    // A Temporal retry of the same step changes nothing and records nothing.
    await asSaga(() => wiring.orders.markFundsHeld(order.id, 'TXN-RETRY'));
    expect(await eventsAbout(org.buyer, order.id, 'ORDER_FUNDS_HELD')).toHaveLength(1);
  });

  it('records a failed funding without the refusal text', async () => {
    const order = await pendingOrder();

    await asSaga(() => wiring.orders.markFailed(order.id, 'wallet ORG-X has insufficient funds'));

    const rows = await eventsAbout(org.buyer, order.id, 'ORDER_FAILED');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].payload)).not.toContain('insufficient');
  });

  it('rolls a saga transition and its event back together', async () => {
    const order = await pendingOrder();
    const spy = failAfterInsert();

    try {
      await expect(
        asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN-${ulid()}`)),
      ).rejects.toThrow('failure after the outbox insert');
    } finally {
      spy.mockRestore();
    }

    const after = await asBuyer(() => wiring.orders.get(order.id));
    expect(after.status).toBe('PENDING');
    expect(after.economicTransactionId).toBeNull();
    expect(await eventsAbout(org.buyer, order.id, 'ORDER_FUNDS_HELD')).toEqual([]);
  });
});
