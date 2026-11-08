import { setTenantEligibilityFixture } from '@rasta/testing';
import { getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { OrderSagaClient } from '../src/temporal/saga.client';
import { SagaStartStore, START_BATCH_SIZE } from '../src/temporal/saga-start.store';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire } from './helpers';

describe('durable saga start delivery (PostgreSQL)', () => {
  const prisma = newPrisma();
  const replica = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  const store = new SagaStartStore(prisma);
  const otherStore = new SagaStartStore(replica);
  const starter = new OrderSagaClient(
    { ...wiring.env, MARKETPLACE_TEMPORAL_ENABLED: true },
    store,
    { provesHeldFunds: async () => true },
  );
  const workflows = new Set<string>();
  const deliveries: string[] = [];
  let down = false;
  const deliver = jest.spyOn(starter, 'deliver').mockImplementation(async (id) => {
    deliveries.push(id);
    if (down) return false;
    workflows.add(id); // Temporal accepts once, then AlreadyStarted (unit-tested).
    return true;
  });

  async function place(buyer = org.buyer) {
    const { offerId } = await publishOffer(wiring, org.supplier);
    return asActor({ organizationId: buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, key('start')),
    );
  }
  const stored = (id: string) =>
    runUnscoped('test reads its own delivery receipt', async () =>
      prisma.client.order.findUniqueOrThrow({ where: { id } }),
    );
  async function due(id: string): Promise<void> {
    await setTenantEligibilityFixture(prisma, 'sagaStartDueAndExpired', org.buyer, [id]);
  }

  beforeEach(() => {
    down = false;
  });
  afterAll(async () => {
    deliver.mockRestore();
    await starter.stop();
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await Promise.all([prisma.onModuleDestroy(), replica.onModuleDestroy()]);
  });

  it('commits intent with placement; a crash before fast start is recovered once', async () => {
    const order = await place();
    expect((await stored(order.id)).sagaStartRequestedAt).not.toBeNull();
    expect((await stored(order.id)).sagaStartDeliveredAt).toBeNull();
    await starter.tick();
    await starter.tick();
    expect(workflows.has(order.id)).toBe(true);
    expect(deliveries.filter((id) => id === order.id)).toHaveLength(1);
    expect((await stored(order.id)).sagaStartDeliveredAt).not.toBeNull();
  });

  it('a placement rollback leaves no order or intent and restores availability', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const stamp = key('rollback');
    await expect(
      asActor({ organizationId: org.buyer }, () =>
        wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, stamp, async () => {
          throw new Error('simulated pre-commit crash');
        }),
      ),
    ).rejects.toThrow('simulated pre-commit crash');
    const rows = await asActor({ organizationId: org.buyer }, async () =>
      prisma.client.order.count({ where: { idempotencyKey: stamp } }),
    );
    expect(rows).toBe(0);
    expect(
      await asActor({ organizationId: org.supplier }, async () =>
        prisma.client.offer.findUniqueOrThrow({ where: { id: offerId } }),
      ),
    ).toHaveProperty('availableQuantity', 10);
  });

  it('Temporal outage and disabled delivery retain intent, then retry later', async () => {
    const order = await place();
    down = true;
    await asActor({ organizationId: org.buyer }, () => starter.start(order.id));
    expect((await stored(order.id)).sagaStartDeliveredAt).toBeNull();
    const disabled = new OrderSagaClient(wiring.env, store, {
      provesHeldFunds: async () => true,
    });
    expect(await disabled.deliver(order.id)).toBe(false);
    await disabled.stop();
    down = false;
    await due(order.id);
    await starter.tick();
    expect((await stored(order.id)).sagaStartDeliveredAt).not.toBeNull();
    expect(workflows.has(order.id)).toBe(true);
  });

  it('acceptance followed by crash before DB ack redelivers with one workflow', async () => {
    const order = await place();
    const originalFinish = store.finish.bind(store);
    const ack = jest.spyOn(store, 'finish').mockRejectedValueOnce(new Error('crash before ack'));
    await asActor({ organizationId: org.buyer }, () => starter.start(order.id));
    expect(workflows.has(order.id)).toBe(true);
    expect((await stored(order.id)).sagaStartDeliveredAt).toBeNull();
    ack.mockImplementation(originalFinish);
    await due(order.id);
    await starter.tick();
    ack.mockRestore();
    expect(deliveries.filter((id) => id === order.id)).toHaveLength(2);
    expect([...workflows].filter((id) => id === order.id)).toHaveLength(1);
    expect((await stored(order.id)).sagaStartDeliveredAt).not.toBeNull();
  });

  it('two replicas claim once; stale token and wrong tenant cannot acknowledge', async () => {
    const order = await place();
    const scope = { id: order.id, organizationId: org.buyer };
    const [left, right] = await Promise.all([store.claim(scope), otherStore.claim(scope)]);
    expect(left.length + right.length).toBe(1);
    const claim = [...left, ...right][0]!;
    expect(await store.finish({ ...claim, organization_id: org.other }, true)).toBe(0);
    await due(order.id);
    const [next] = await otherStore.claim(scope);
    expect(next.token).not.toBe(claim.token);
    expect(await store.finish(claim, true)).toBe(0);
    expect(await otherStore.finish(next, true)).toBe(1);
  });

  it('fast path cannot claim another buyer and scanner derives persisted ownership', async () => {
    const order = await place(org.other);
    await asActor({ organizationId: org.buyer }, () => starter.start(order.id));
    expect((await stored(order.id)).sagaStartDeliveredAt).toBeNull();
    const [claim] = await store.claim();
    expect(claim.organization_id).toBe(org.other);
    // No caller tenant is used to acknowledge platform plumbing.
    await asActor({ organizationId: org.buyer }, async () => {
      expect(getOrganizationId()).toBe(org.buyer);
      expect(await store.finish(claim, true)).toBe(1);
    });
  });

  it('legacy PENDING and CANCELLING remain in the recovery set', async () => {
    const order = await place();
    await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.cancel(order.id, { reason: 'cancel before start' }),
    );
    await prisma.client.$executeRaw`UPDATE "order" SET saga_start_requested_at = NULL
      WHERE id = ${order.id} AND organization_id = ${org.buyer}`;
    const [claim] = await store.claim({ id: order.id, organizationId: org.buyer });
    expect(claim.first_possible_start_at).toEqual((await stored(order.id)).createdAt);
    expect((await stored(order.id)).status).toBe('CANCELLING');
    await store.finish(claim, true);
  });

  it('bounded batches progress past failures and durable receipts survive retention', async () => {
    const orders = await Promise.all(Array.from({ length: START_BATCH_SIZE + 1 }, () => place()));
    down = true;
    await starter.tick();
    down = false;
    await starter.tick();
    expect(deliveries.filter((id) => orders.some((o) => o.id === id))).toHaveLength(
      START_BATCH_SIZE + 1,
    );
    for (const order of orders) await due(order.id);
    await starter.tick();
    await starter.tick();
    for (const order of orders) {
      expect((await stored(order.id)).sagaStartDeliveredAt).not.toBeNull();
      await due(order.id);
      expect(await store.claim({ id: order.id, organizationId: org.buyer })).toEqual([]);
    }
  });
});
