import { runUnscoped } from '@rasta/nest-common';
import { SagaStartStore, UNCONFIRMED_CALL_GRACE_SECONDS } from '../src/temporal/saga-start.store';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/** The state behind the unconfirmed-release alert (FU-104), against the real database. */
describe('saga_unconfirmed_call (PostgreSQL)', () => {
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const store = new SagaStartStore(prisma);
  const org = tenants();
  const other = tenants();
  const OPERATION = 'resolveObligationDispute';

  async function place(buyer: string, supplier: string) {
    const { offerId } = await publishOffer(wiring, supplier);
    const placed = await asActor({ organizationId: buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, key('call')),
    );
    return { id: placed.id, organizationId: buyer };
  }

  const open = async (graceSeconds = 0) =>
    (await store.unconfirmedCalls(graceSeconds)).find((row) => row.operation === OPERATION)
      ?.count ?? 0;

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, other.buyer, other.supplier]);
    await prisma.onModuleDestroy();
  });

  it('counts a call past its grace, across tenants, until it is confirmed', async () => {
    const before = await open();
    const beforeGrace = await open(UNCONFIRMED_CALL_GRACE_SECONDS);
    const first = await place(org.buyer, org.supplier);
    const second = await place(other.buyer, other.supplier);

    await wiring.orders.openSagaCall(first, OPERATION, 'DSP_1');
    await wiring.orders.openSagaCall(second, OPERATION, 'DSP_2');
    expect(await open()).toBe(before + 2);
    // Within its grace it is a call in flight.
    expect(await open(UNCONFIRMED_CALL_GRACE_SECONDS)).toBe(beforeGrace);

    await wiring.orders.confirmSagaCall(first, OPERATION, 'DSP_1');
    expect(await open()).toBe(before + 1);
    await wiring.orders.confirmSagaCall(second, OPERATION, 'DSP_2');
    expect(await open()).toBe(before);
  });

  it('a late attempt cannot reopen what was confirmed; another dispute is its own', async () => {
    const before = await open();
    const order = await place(org.buyer, org.supplier);

    await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_A');
    await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    expect(await open()).toBe(before);

    await wiring.orders.openSagaCall(order, OPERATION, 'DSP_B');
    expect(await open()).toBe(before + 1);
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_B');
  });

  it('confirming names the call: another subject or tenant stays open', async () => {
    const before = await open();
    const order = await place(org.buyer, org.supplier);
    await wiring.orders.openSagaCall(order, OPERATION, 'DSP_X');

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_Y');
    await wiring.orders.confirmSagaCall(
      { id: order.id, organizationId: other.buyer },
      OPERATION,
      'DSP_X',
    );
    expect(await open()).toBe(before + 1);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_X');
  });

  it('refuses a call on another tenant’s order: the key names the buyer', async () => {
    const order = await place(org.buyer, org.supplier);

    await expect(
      wiring.orders.openSagaCall({ id: order.id, organizationId: other.buyer }, OPERATION, 'DSP_T'),
    ).rejects.toThrow();
    const rows = await runUnscoped('the test reads what the refused write left', () =>
      prisma.client.sagaUnconfirmedCall.count({ where: { orderId: order.id } }),
    );
    expect(rows).toBe(0);
  });
});
