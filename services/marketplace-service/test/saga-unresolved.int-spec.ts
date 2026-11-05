import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import type { EconomicClient } from '../src/economic/economic.client';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  openDisputeId,
  publishOffer,
  resolveOpenDispute,
  sagaStep,
  tenants,
  wire,
} from './helpers';

/**
 * #770 r2 F3: unresolved financial uncertainty as **state**, read from the
 * database, so it stays until the order moves on — not a count of retries,
 * which stops when the retries do. Real domain commands and saga activities on
 * the real schema; economic-service is the only stand-in.
 *
 * The query is cross-tenant (platform plumbing), so other suites' orders may
 * be in the database: cases compare counts before and after, and age an
 * order's whole timeline by thousands of days so it is certainly the oldest.
 */
describe('saga unresolved financial state (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  const store = new SagaStartStore(prisma);
  const economic = {
    dispute: async () => ({ disputeId: `TXD_${ulid()}` }),
    resolveDispute: async () => undefined,
  } as unknown as EconomicClient;
  const acts: OrderActivities = createActivities({
    orders: wiring.orders,
    economic,
    currentStep: sagaStep,
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-F3-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-F3-S' }, fn);
  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['SYSTEM_ADMIN'], userId: 'USR-F3-OPS' }, fn);

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  async function place(): Promise<string> {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('f3')),
    );
    return order.id;
  }

  async function held(): Promise<{ orderId: string; transactionId: string }> {
    const orderId = await place();
    const transactionId = `TXN_${ulid()}`;
    await acts.markFundsHeld(orderId, transactionId);
    return { orderId, transactionId };
  }

  async function receiptConfirmed(): Promise<string> {
    const { orderId } = await held();
    await asSupplier(() => wiring.orders.confirm(orderId));
    await asSupplier(() => wiring.orders.fulfill(orderId, { trackingReference: 'TRK-F3' }));
    await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
    return orderId;
  }

  /** Moves the order's whole timeline back by `days`, keeping its order of events. */
  async function age(orderId: string, days: number): Promise<void> {
    await runUnscoped('the suite ages the timeline of an order it wrote', async () => {
      const shift = `${days} days`;
      await prisma.client
        .$executeRaw`UPDATE "order" SET created_at = created_at - ${shift}::interval WHERE id = ${orderId}`;
      await prisma.client
        .$executeRaw`UPDATE order_status_history SET occurred_at = occurred_at - ${shift}::interval WHERE order_id = ${orderId}`;
      await prisma.client
        .$executeRaw`UPDATE saga_step SET applied_at = applied_at - ${shift}::interval WHERE order_id = ${orderId}`;
    });
  }

  async function read(): Promise<Record<string, { count: number; days: number }>> {
    return Object.fromEntries(
      (await store.unresolved()).map(({ reason, count, age: seconds }) => [
        reason,
        { count, days: seconds / 86_400 },
      ]),
    );
  }

  it('always reports every reason, so no series goes missing for want of an order', async () => {
    expect(Object.keys(await read()).sort()).toEqual(
      ['CANCELLING', 'DISPUTE_RELEASE', 'PENDING', 'RECEIPT_CONFIRMED', 'SETTLING'].sort(),
    );
  });

  it('counts an order in the saga custody until it leaves, aged from when it entered', async () => {
    const before = await read();
    const orderId = await place();
    await age(orderId, 1000);
    const pending = await read();
    expect(pending.PENDING!.count).toBe(before.PENDING!.count + 1);
    expect(pending.PENDING!.days).toBeGreaterThan(999.9);

    await acts.markFundsHeld(orderId, `TXN_${ulid()}`);
    const funded = await read();
    // A party wait with no dispute mirrored: nothing the saga owes.
    expect(funded.PENDING!.count).toBe(before.PENDING!.count);
    expect(funded.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
  });

  it('keeps the age of a settlement that bounces RECEIPT_CONFIRMED ↔ SETTLING (retries do not reset it)', async () => {
    const orderId = await receiptConfirmed();
    await age(orderId, 2000);
    await acts.markSettling(orderId);
    expect((await read()).SETTLING!.days).toBeGreaterThan(1999.9);
    await acts.markSettlementFailed(orderId);
    // Retries over and the saga stopped (settlement exhausted): still owed, still old.
    expect((await read()).RECEIPT_CONFIRMED!.days).toBeGreaterThan(1999.9);
  });

  it('counts a cancellation until the refund is recorded, never a finished order', async () => {
    const before = await read();
    const { orderId } = await held();
    await asBuyer(() => wiring.orders.cancel(orderId, { reason: 'no longer needed' }));
    expect((await read()).CANCELLING!.count).toBe(before.CANCELLING!.count + 1);
    await acts.markCancelled(orderId, 'no longer needed');
    expect((await read()).CANCELLING!.count).toBe(before.CANCELLING!.count);
  });

  it('counts a mirrored dispute settled back before receipt until economic-service releases it', async () => {
    const before = await read();
    const { orderId, transactionId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    const disputeId = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, disputeId, 'goods are not as ordered');
    // While DISPUTED it waits on the operator, not on the saga.
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);

    await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'SETTLE',
        resolution: 'supplier showed delivery',
        responsibility: 'BUYER',
      }),
    );
    await age(orderId, 3000);
    const owed = await read();
    expect(owed.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(owed.DISPUTE_RELEASE!.days).toBeGreaterThan(2999.9);

    await acts.resolveObligationDispute(
      orderId,
      transactionId,
      disputeId,
      'supplier showed delivery',
    );
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
  });

  it('does not count a dispute decided before the saga mirrored it (economic-service never held it)', async () => {
    const before = await read();
    const { orderId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'SETTLE',
        resolution: 'supplier showed delivery',
        responsibility: 'BUYER',
      }),
    );
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
  });
});
