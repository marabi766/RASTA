import { runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import type { EconomicClient } from '../src/economic/economic.client';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  NO_DISPUTE,
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

  // A session whose TimeZone is not UTC: times without a zone are UTC wall
  // time, so an age must not move with the session's zone.
  const tehranUrl = new URL(process.env.DATABASE_URL_MARKETPLACE ?? process.env.DATABASE_URL ?? '');
  tehranUrl.searchParams.set('options', '-c TimeZone=Asia/Tehran');
  const tehran = new PrismaService(tehranUrl.toString());
  const tehranStore = new SagaStartStore(tehran);

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await Promise.all([prisma.onModuleDestroy(), tehran.onModuleDestroy()]);
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
      await prisma.client
        .$executeRaw`UPDATE order_dispute SET raised_at = raised_at - ${shift}::interval,
          resolved_at = resolved_at - ${shift}::interval WHERE order_id = ${orderId}`;
      await prisma.client
        .$executeRaw`UPDATE saga_unconfirmed_call SET opened_at = opened_at - ${shift}::interval WHERE order_id = ${orderId}`;
    });
  }

  async function read(
    from = store,
  ): Promise<Record<string, { count: number; days: number; overdue: number }>> {
    return Object.fromEntries(
      (await from.unresolved()).map(({ reason, count, age: seconds, overdue }) => [
        reason,
        { count, days: seconds / 86_400, overdue },
      ]),
    );
  }

  const settle = {
    outcome: 'SETTLE',
    resolution: 'supplier showed delivery',
    responsibility: 'BUYER',
  } as const;

  /** A held order whose dispute the saga mirrored, then an operator settled. */
  async function decided(): Promise<{ orderId: string; transactionId: string; disputeId: string }> {
    const { orderId, transactionId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    const disputeId = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, disputeId, 'goods are not as ordered');
    await asOperator(() => resolveOpenDispute(wiring, orderId, settle));
    return { orderId, transactionId, disputeId };
  }

  const unscoped = <T>(fn: () => Promise<T>) =>
    runUnscoped('the suite moves the platform reference clock', fn);

  it('always reports every reason, so no series goes missing for want of an order', async () => {
    expect(Object.keys(await read()).sort()).toEqual(
      [
        'CANCELLING',
        'DISPUTE_RELEASE',
        'PENDING',
        'RECEIPT_CONFIRMED',
        'SETTLING',
        'UNCONFIRMED_CALL',
      ].sort(),
    );
  });

  it('counts an order in the saga custody until it leaves, aged from when it entered', async () => {
    const before = await read();
    const orderId = await place();
    await age(orderId, 1000);
    const pending = await read();
    expect(pending.PENDING!.count).toBe(before.PENDING!.count + 1);
    expect(pending.PENDING!.days).toBeGreaterThan(999.9);
    expect(pending.PENDING!.overdue).toBe(before.PENDING!.overdue + 1);

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
  it('measures the same age whatever the session time zone (UTC wall time)', async () => {
    const orderId = await place();
    await age(orderId, 4000);
    for (const from of [store, tehranStore]) {
      const { days } = (await read(from)).PENDING!;
      expect(days).toBeGreaterThan(3999.99);
      expect(days).toBeLessThan(4000.01);
    }
    const [backlogUtc, backlogTehran] = await Promise.all([store.backlog(), tehranStore.backlog()]);
    expect(Math.abs(backlogUtc.age - backlogTehran.age)).toBeLessThan(60);
    await acts.markFundsHeld(orderId, `TXN_${ulid()}`);
  });

  it('keeps an owed release counted, and its age, when a party moves the order on (review F1)', async () => {
    const before = await read();
    const { orderId, transactionId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    const disputeId = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, disputeId, 'goods are not as ordered');
    await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'SETTLE',
        resolution: 'supplier showed delivery',
        responsibility: 'BUYER',
      }),
    );
    await age(orderId, 5000);
    // The release failed and the saga ended; the parties carry on regardless.
    await asSupplier(() => wiring.orders.confirm(orderId));
    await asSupplier(() => wiring.orders.fulfill(orderId, { trackingReference: 'TRK-F3' }));
    await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
    const after = await read();
    expect(after.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(after.DISPUTE_RELEASE!.days).toBeGreaterThan(4999.9);
    // Each is an episode of its own (#792 r1 F1): the settlement now owed counts
    // too, aged from the receipt; the release keeps its own age and record.
    expect(after.RECEIPT_CONFIRMED!.count).toBe(before.RECEIPT_CONFIRMED!.count + 1);

    await acts.resolveObligationDispute(
      orderId,
      transactionId,
      disputeId,
      'supplier showed delivery',
    );
    const released = await read();
    expect(released.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
    // Released, the settlement is what is left owed.
    expect(released.RECEIPT_CONFIRMED!.count).toBe(before.RECEIPT_CONFIRMED!.count + 1);
  });

  // #792 r1 F1: the release owed comes from the durable record of the call,
  // one row per dispute, not from best-effort saga_step rows and their times.
  it('counts a release whose mirror left no step record', async () => {
    const before = await read();
    const { orderId } = await decided();
    // onceForSaga's record of the mirror failed after economic-service took it.
    await runUnscoped(
      'the suite loses the step records of an order it wrote',
      () => prisma.client.$executeRaw`DELETE FROM saga_step WHERE order_id = ${orderId}`,
    );
    await age(orderId, 3000);
    const after = await read();
    expect(after.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(after.DISPUTE_RELEASE!.overdue).toBe(before.DISPUTE_RELEASE!.overdue + 1);
    expect(after.DISPUTE_RELEASE!.days).toBeGreaterThan(2999.9);
  });

  it('keeps the first release owed, and its age, through a second dispute raised and decided', async () => {
    const before = await read();
    const { orderId, transactionId, disputeId: first } = await decided();
    await age(orderId, 6000);
    // Back in a party wait, the buyer disputes again: the order is DISPUTED,
    // the first release still owed (the saga releases it before mirroring).
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'still not as ordered' }));
    const second = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, second, 'still not as ordered');
    const disputed = await read();
    expect(disputed.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(disputed.DISPUTE_RELEASE!.days).toBeGreaterThan(5999.9);

    await asOperator(() => resolveOpenDispute(wiring, orderId, settle));
    const both = await read();
    expect(both.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 2);
    // The second decision does not re-age the first release.
    expect(both.DISPUTE_RELEASE!.days).toBeGreaterThan(5999.9);
    expect(both.DISPUTE_RELEASE!.overdue).toBe(before.DISPUTE_RELEASE!.overdue + 1);

    await acts.resolveObligationDispute(orderId, transactionId, first, settle.resolution);
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    await acts.resolveObligationDispute(orderId, transactionId, second, settle.resolution);
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
  });

  it.each([
    ['an old release stamped after the new mirror (a clock set back)', '1 hour'],
    ['the release and the new mirror stamped the same', '0 seconds'],
  ])('counts the new release owed whatever the step times say: %s', async (_name, later) => {
    const before = await read();
    const { orderId, transactionId, disputeId: first } = await decided();
    await acts.resolveObligationDispute(orderId, transactionId, first, settle.resolution);
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'still not as ordered' }));
    const second = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, second, 'still not as ordered');
    await asOperator(() => resolveOpenDispute(wiring, orderId, settle));
    await runUnscoped('the suite restamps the step records of an order it wrote', async () => {
      const [{ mirrored }] = await prisma.client.$queryRaw<{ mirrored: Date }[]>`
        SELECT max(applied_at) AS mirrored FROM saga_step WHERE order_id = ${orderId}
          AND activity IN ('disputeObligation', 'markObligationDisputed')`;
      await prisma.client.$executeRaw`UPDATE saga_step
        SET applied_at = ${mirrored}::timestamptz + ${later}::interval
        WHERE order_id = ${orderId} AND activity = 'resolveObligationDispute'`;
    });
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    await acts.resolveObligationDispute(orderId, transactionId, second, settle.resolution);
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);
  });

  it('counts an open record whatever the order status, and one with nothing behind it', async () => {
    const before = await read();
    const { orderId } = await held();
    await asBuyer(() => wiring.orders.cancel(orderId, { reason: 'no longer needed' }));
    await acts.markCancelled(orderId, 'no longer needed');
    const order = { id: orderId, organizationId: org.buyer };
    // A release whose dispute row is gone, on a finished order; another call.
    await wiring.orders.openSagaCall(order, 'resolveObligationDispute', NO_DISPUTE);
    await wiring.orders.openSagaCall(order, 'compensate' as never, 'refund');
    await age(orderId, 7000);
    const after = await read();
    expect(after.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(after.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
    expect(after.UNCONFIRMED_CALL!.overdue).toBe(before.UNCONFIRMED_CALL!.overdue + 1);
    expect(after.UNCONFIRMED_CALL!.days).toBeGreaterThan(6999.9);
  });

  it('leaves out only an open dispute on an order still DISPUTED; any other open record counts', async () => {
    const before = await read();
    const { orderId, transactionId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    const disputeId = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, disputeId, 'goods are not as ordered');
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count);

    // Still DISPUTED, but a record with no dispute behind it: unknown, so counted.
    const order = { id: orderId, organizationId: org.buyer };
    await wiring.orders.openSagaCall(order, 'resolveObligationDispute', NO_DISPUTE);
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);

    // The dispute still open, the order no longer DISPUTED (moved by hand):
    // nothing says the operator still decides, so it counts too.
    await runUnscoped('the suite moves an order it wrote out of DISPUTED by hand', () =>
      prisma.client.$executeRaw`UPDATE "order" SET status = 'FUNDS_HELD' WHERE id = ${orderId}`,
    );
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 2);
  });

  it('owes a release from its decision, not from when economic-service was told', async () => {
    const before = await read();
    const { orderId, transactionId } = await held();
    await asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'goods are not as ordered' }),
    );
    const disputeId = await openDisputeId(prisma, orderId);
    await acts.disputeObligation(orderId, transactionId, disputeId, 'goods are not as ordered');
    // Disputed for ten days, decided just now: due now, not ten days ago.
    await age(orderId, 10);
    await asOperator(() => resolveOpenDispute(wiring, orderId, settle));
    const after = await read();
    expect(after.DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);
    expect(after.DISPUTE_RELEASE!.overdue).toBe(before.DISPUTE_RELEASE!.overdue);
  });

  // #792 r1 F2: the database clock set back must not make an episode young again.
  it('ages against a reference that never runs back, so a clock set back clears nothing', async () => {
    const highWater = async () => {
      const [{ at }] = await unscoped(
        () =>
          prisma.client.$queryRaw<{ at: Date }[]>`SELECT high_water AS at FROM saga_monitor_clock`,
      );
      return at;
    };
    const orderId = await place();
    // Opened two hours before a clock that ran two days ahead, then was set back.
    await wiring.orders.openSagaCall(
      { id: orderId, organizationId: org.buyer },
      'compensate' as never,
      'clock',
    );
    await unscoped(
      () => prisma.client.$executeRaw`UPDATE saga_unconfirmed_call
        SET opened_at = clock_timestamp() + interval '46 hours' WHERE order_id = ${orderId}`,
    );
    const was = await highWater();
    try {
      // Against today's clock it is not even open yet: young.
      const young = (await read()).UNCONFIRMED_CALL!.overdue;
      // The readers saw the clock two days ahead: the reference stays there.
      await unscoped(
        () => prisma.client.$executeRaw`UPDATE saga_monitor_clock
          SET high_water = clock_timestamp() + interval '2 days'`,
      );
      for (let again = 0; again < 3; again += 1) {
        expect((await read()).UNCONFIRMED_CALL!.overdue).toBe(young + 1);
      }
      expect((await highWater()).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
      // The backlog ages against the same reference.
      expect((await store.backlog()).age).toBeGreaterThan(2 * 86_400 - 120);

      // A reader moves it forward, never back.
      await unscoped(
        () => prisma.client.$executeRaw`UPDATE saga_monitor_clock
          SET high_water = clock_timestamp() - interval '1 day'`,
      );
      await read();
      expect((await highWater()).getTime()).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await unscoped(
        () => prisma.client.$executeRaw`UPDATE saga_monitor_clock SET high_water = ${was}`,
      );
      await acts.markFundsHeld(orderId, `TXN_${ulid()}`);
    }
  });

  it('refuses to sample without the reference row, rather than age against nothing', async () => {
    const [{ was }] = await unscoped(
      () =>
        prisma.client.$queryRaw<{ was: Date }[]>`SELECT high_water AS was FROM saga_monitor_clock`,
    );
    await unscoped(() => prisma.client.$executeRaw`DELETE FROM saga_monitor_clock`);
    try {
      await expect(store.unresolved()).rejects.toThrow(/saga_monitor_clock has no row/);
      await expect(store.backlog()).rejects.toThrow(/saga_monitor_clock has no row/);
    } finally {
      await unscoped(
        () =>
          prisma.client
            .$executeRaw`INSERT INTO saga_monitor_clock (id, high_water) VALUES (1, ${was})`,
      );
    }
  });
});
