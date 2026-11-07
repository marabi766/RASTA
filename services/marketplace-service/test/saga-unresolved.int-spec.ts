import { runUnscoped } from '@rasta/nest-common';
import { inSessionZone } from '@rasta/testing';
import { ulid } from 'ulid';
import { createActivities, type OrderActivities } from '../src/temporal/activities';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import type { EconomicClient } from '../src/economic/economic.client';
import type { SagaStep } from '../src/order/order.repository';
import { RastaError } from '@rasta/nest-common';
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
    // economic-service with the D-150 rule, which the row's proof needs (FU-233, #948):
    // every stub below spreads this one, so a hold is sent and its record opened.
    requiresOrderHoldDeadline: async () => true,
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
    // A session outside UTC can no longer connect (FU-188, #906); inSessionZone switches
    // the zone inside one rolled-back transaction, past that check, so the SQL itself is
    // what keeps the age off the session's zone: times without a zone are UTC wall time.
    const backlogUtc = await store.backlog();
    for (const name of ['UTC', 'Asia/Tehran', 'America/Los_Angeles']) {
      await inSessionZone(prisma, async ({ db, zone }) => {
        await zone(name);
        const inZone = new SagaStartStore(db);
        const { days } = (await read(inZone)).PENDING!;
        expect(days).toBeGreaterThan(3999.99);
        expect(days).toBeLessThan(4000.01);
        expect(Math.abs((await inZone.backlog()).age - backlogUtc.age)).toBeLessThan(60);
      });
    }
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
    await wiring.orders.openSagaCall(order, 'resolveObligationDispute', NO_DISPUTE, sagaStep());
    await wiring.orders.openSagaCall(order, 'compensate' as never, 'refund', sagaStep());
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
    await wiring.orders.openSagaCall(order, 'resolveObligationDispute', NO_DISPUTE, sagaStep());
    expect((await read()).DISPUTE_RELEASE!.count).toBe(before.DISPUTE_RELEASE!.count + 1);

    // The dispute still open, the order no longer DISPUTED (moved by hand):
    // nothing says the operator still decides, so it counts too.
    await runUnscoped(
      'the suite moves an order it wrote out of DISPUTED by hand',
      () =>
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
      sagaStep(),
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
      // Gone between the move and the read: the read itself refuses, rather
      // than take an empty result for no episode.
      const moved = jest
        .spyOn(store as unknown as { advanceReference(): Promise<void> }, 'advanceReference')
        .mockResolvedValue(undefined);
      try {
        await expect(store.unresolved()).rejects.toThrow(/saga_monitor_clock has no row/);
        await expect(store.backlog()).rejects.toThrow(/saga_monitor_clock has no row/);
      } finally {
        moved.mockRestore();
      }
    } finally {
      await unscoped(
        () =>
          prisma.client
            .$executeRaw`INSERT INTO saga_monitor_clock (id, high_water) VALUES (1, ${was})`,
      );
    }
  });

  // #792 r2 F2 (FU-145): an authorisation or settlement economic-service never
  // answered is money in an unknown state, whatever the order's status becomes
  // next. A buyer's dispute and an operator's decision pause settlement; they
  // do not confirm a command already sent. Until economic-service answers, the
  // call stays one episode, aged from its first opening.
  describe('an unanswered authorisation or settlement (#792 r2 F2)', () => {
    const answers = { authorise: true, settle: true };
    const lost = () => new Error('economic-service did not answer (socket hang up)');
    const money: OrderActivities = createActivities({
      orders: wiring.orders,
      economic: {
        ...economic,
        // An authorisation outside a worker is in doubt (FU-103) and reads the
        // obligation: still HELD, so the lost call stays unanswered.
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
        authoriseSettlement: async () => {
          if (!answers.authorise) throw lost();
        },
        settle: async () => {
          if (!answers.settle) throw lost();
          return { settlementId: `STL_${ulid()}`, commissionAmountMinor: '0', netAmountMinor: '0' };
        },
        refund: async () => undefined,
      } as unknown as EconomicClient,
      currentStep: sagaStep,
    });
    afterEach(() => {
      answers.authorise = true;
      answers.settle = true;
    });

    async function awaitingSettlement(): Promise<{ orderId: string; transactionId: string }> {
      const { orderId, transactionId } = await held();
      await asSupplier(() => wiring.orders.confirm(orderId));
      await asSupplier(() => wiring.orders.fulfill(orderId, { trackingReference: 'TRK-F2' }));
      await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
      return { orderId, transactionId };
    }

    /** What `settleOrder` does when no settlement attempt is answered: SETTLEMENT_EXHAUSTED. */
    async function exhaust(orderId: string, transactionId: string): Promise<void> {
      answers.settle = false;
      await money.authoriseSettlement(orderId, transactionId);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(await money.markSettling(orderId)).toBe('SETTLING');
        await expect(money.settle(orderId, transactionId)).rejects.toThrow(/did not answer/);
        await money.markSettlementFailed(orderId);
      }
    }

    const overdue = (state: Record<string, { overdue: number }>) =>
      Object.values(state).reduce((sum, { overdue: n }) => sum + n, 0);

    it('keeps an exhausted settlement owed, and its age, through a buyer dispute and its decision', async () => {
      const before = await read();
      const { orderId, transactionId } = await awaitingSettlement();
      await exhaust(orderId, transactionId);
      await age(orderId, 8000);

      // The review's sequence: the buyer disputes the order the saga left RECEIPT_CONFIRMED.
      await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'paid, never settled' }));
      const disputed = await read();
      expect(disputed.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(disputed.UNCONFIRMED_CALL!.days).toBeGreaterThan(7999.9);
      expect(overdue(disputed)).toBe(overdue(before) + 1);

      // The saga mirrors it, an operator decides: the age does not restart.
      const disputeId = await openDisputeId(prisma, orderId);
      await money.disputeObligation(orderId, transactionId, disputeId, 'paid, never settled');
      await asOperator(() => resolveOpenDispute(wiring, orderId, settle));
      const decided = await read();
      expect(decided.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(decided.UNCONFIRMED_CALL!.days).toBeGreaterThan(7999.9);
      expect(decided.UNCONFIRMED_CALL!.overdue).toBe(before.UNCONFIRMED_CALL!.overdue + 1);

      // Only economic-service's answer ends it: released, authorised, settled.
      await money.resolveObligationDispute(orderId, transactionId, disputeId, settle.resolution);
      answers.settle = true;
      await money.authoriseSettlement(orderId, transactionId);
      expect(await money.markSettling(orderId)).toBe('SETTLING');
      await money.settle(orderId, transactionId);
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count);
    });

    it('keeps an unanswered authorisation owed, and its age, through a buyer dispute and its decision', async () => {
      const before = await read();
      const { orderId, transactionId } = await awaitingSettlement();
      answers.authorise = false;
      await expect(money.authoriseSettlement(orderId, transactionId)).rejects.toThrow(
        /did not answer/,
      );
      await age(orderId, 9000);

      await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'paid, never settled' }));
      const disputed = await read();
      expect(disputed.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(disputed.UNCONFIRMED_CALL!.days).toBeGreaterThan(8999.9);
      expect(overdue(disputed)).toBe(overdue(before) + 1);

      const disputeId = await openDisputeId(prisma, orderId);
      await money.disputeObligation(orderId, transactionId, disputeId, 'paid, never settled');
      await asOperator(() =>
        resolveOpenDispute(wiring, orderId, {
          outcome: 'REFUND',
          resolution: 'never delivered',
          responsibility: 'SUPPLIER',
        }),
      );
      const decided = await read();
      expect(decided.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(decided.UNCONFIRMED_CALL!.days).toBeGreaterThan(8999.9);

      // A confirmed refund of the same obligation is economic-service's final
      // word on it: REFUNDED is terminal, so no authorisation or settlement of
      // it is still in doubt.
      await money.resolveObligationDispute(orderId, transactionId, disputeId, 'never delivered');
      await money.compensate(orderId, transactionId, 'never delivered');
      await money.markCancelled(orderId, 'never delivered');
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count);
    });

    it('starts a new episode for a call confirmed and then made again, and keeps the first while unanswered', async () => {
      const before = await read();
      const { orderId, transactionId } = await awaitingSettlement();
      // Authorised and confirmed long ago.
      await money.authoriseSettlement(orderId, transactionId);
      await age(orderId, 9500);
      // A later authorisation (after a dispute decided SETTLE) is a new command:
      // not overdue from the first one's time.
      answers.authorise = false;
      await expect(money.authoriseSettlement(orderId, transactionId)).rejects.toThrow(
        /did not answer/,
      );
      const again = await read();
      expect(again.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(again.UNCONFIRMED_CALL!.overdue).toBe(before.UNCONFIRMED_CALL!.overdue);
      // Unanswered again: the retry does not restart it.
      await age(orderId, 9600);
      await expect(money.authoriseSettlement(orderId, transactionId)).rejects.toThrow(
        /did not answer/,
      );
      expect((await read()).UNCONFIRMED_CALL!.days).toBeGreaterThan(9599.9);
      answers.authorise = true;
      await money.authoriseSettlement(orderId, transactionId);
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count);
    });

    it("closes on a refund only that order's own rows of that obligation (AGENTS.md tenancy)", async () => {
      const before = await read();
      const mine = await awaitingSettlement();
      const theirs = await awaitingSettlement();
      answers.authorise = false;
      // The same subject on another order, and another subject on this one.
      for (const [orderId, subject] of [
        [mine.orderId, mine.transactionId],
        [theirs.orderId, mine.transactionId],
        [mine.orderId, `TXN_${ulid()}`],
      ] as const) {
        await expect(money.authoriseSettlement(orderId, subject)).rejects.toThrow(/did not answer/);
      }
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 3);
      await money.compensate(mine.orderId, mine.transactionId, 'never delivered');
      // Its own refund row and authorisation of that obligation close; nothing else does.
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 2);
      await runUnscoped(
        'the suite closes the rows it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE order_id IN (${mine.orderId}, ${theirs.orderId}) AND confirmed_at IS NULL`,
      );
    });

    it('counts an unanswered refund, which only its own confirmation ends', async () => {
      const before = await read();
      const { orderId, transactionId } = await held();
      await asBuyer(() => wiring.orders.cancel(orderId, { reason: 'no longer needed' }));
      const refusing = createActivities({
        orders: wiring.orders,
        economic: {
          refund: async () => {
            throw lost();
          },
        } as unknown as EconomicClient,
        currentStep: sagaStep,
      });
      await expect(refusing.compensate(orderId, transactionId, 'no longer needed')).rejects.toThrow(
        /did not answer/,
      );
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      await money.compensate(orderId, transactionId, 'no longer needed');
      await money.markCancelled(orderId, 'no longer needed');
      expect((await read()).UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count);
    });
  });
  // #836 r1 R1: a call record belongs to the scheduled command that opened it
  // last, not to the latest database opening. Every recorded operation, through
  // the activities themselves: what the review executed.
  describe('a call record is bound to its scheduled command (#836 r1 R1)', () => {
    /** A statement writing the record (this release's opening, or 12f8f78e's upsert). */
    const WRITES_CALL_RECORD = String.raw`^\s*(insert\s+into|update)\s+("public"\.)?"?saga_unconfirmed_call`;
    let step: SagaStep = sagaStep();
    let answering = true;
    const lost = () => new Error('economic-service did not answer (socket hang up)');
    const answer = async <T>(value: T): Promise<T> => {
      if (!answering) throw lost();
      return value;
    };
    const transactionOf = new Map<string, string>();
    const bound: OrderActivities = createActivities({
      orders: wiring.orders,
      economic: {
        ...economic,
        createObligation: () => answer({ id: `TXN_${ulid()}` }),
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
        authoriseSettlement: () => answer(undefined),
        settle: () =>
          answer({
            settlementId: `STL_${ulid()}`,
            commissionAmountMinor: '0',
            netAmountMinor: '0',
          }),
        refund: () => answer(undefined),
        resolveDispute: () => answer(undefined),
      } as unknown as EconomicClient,
      currentStep: () => step,
    });
    afterEach(() => {
      answering = true;
    });

    async function awaitingSettlement(): Promise<{ orderId: string; transactionId: string }> {
      const { orderId, transactionId } = await held();
      await asSupplier(() => wiring.orders.confirm(orderId));
      await asSupplier(() => wiring.orders.fulfill(orderId, { trackingReference: 'TRK-R1' }));
      await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
      return { orderId, transactionId };
    }

    /** Each recorded operation: an order it can be made on, its subject, the call. */
    const operations: {
      operation: string;
      setup: () => Promise<{ orderId: string; subject: string }>;
      call: (orderId: string) => Promise<unknown>;
    }[] = [
      {
        operation: 'createObligation',
        setup: async () => {
          const orderId = await place();
          return { orderId, subject: orderId };
        },
        call: (orderId) => bound.createObligation(orderId),
      },
      {
        operation: 'authoriseSettlement',
        setup: async () => {
          const { orderId, transactionId } = await awaitingSettlement();
          transactionOf.set(orderId, transactionId);
          return { orderId, subject: transactionId };
        },
        call: (orderId) => bound.authoriseSettlement(orderId, transactionOf.get(orderId)!),
      },
      {
        operation: 'settle',
        setup: async () => {
          const { orderId, transactionId } = await awaitingSettlement();
          transactionOf.set(orderId, transactionId);
          return { orderId, subject: transactionId };
        },
        call: (orderId) => bound.settle(orderId, transactionOf.get(orderId)!),
      },
      {
        operation: 'compensate',
        setup: async () => {
          const { orderId, transactionId } = await held();
          transactionOf.set(orderId, transactionId);
          return { orderId, subject: transactionId };
        },
        call: (orderId) =>
          bound.compensate(orderId, transactionOf.get(orderId)!, 'no longer needed'),
      },
      {
        operation: 'resolveObligationDispute',
        setup: async () => {
          const { orderId, transactionId, disputeId } = await decided();
          transactionOf.set(orderId, transactionId);
          return { orderId, subject: disputeId };
        },
        call: async (orderId) => {
          const disputeId = await disputeOf(orderId);
          return bound.resolveObligationDispute(
            orderId,
            transactionOf.get(orderId)!,
            disputeId,
            settle.resolution,
          );
        },
      },
    ];

    async function disputeOf(orderId: string): Promise<string> {
      const [row] = await runUnscoped(
        'the suite reads the dispute it decided',
        () =>
          prisma.client.$queryRaw<{ id: string }[]>`
          SELECT id FROM order_dispute WHERE order_id = ${orderId} ORDER BY raised_at DESC LIMIT 1`,
      );
      return row!.id;
    }

    async function record(orderId: string, operation: string, subject: string) {
      const [row] = await runUnscoped(
        'the suite reads the call record it wrote',
        () =>
          prisma.client.$queryRaw<{ open: boolean; age: number; generation: number }[]>`
          SELECT confirmed_at IS NULL AS open, generation,
            EXTRACT(EPOCH FROM clock_timestamp() - opened_at)::float AS age
          FROM saga_unconfirmed_call
          WHERE order_id = ${orderId} AND operation = ${operation} AND subject = ${subject}`,
      );
      return row!;
    }

    it.each(operations)(
      "$operation: an older command's late attempt, answered from its step record, leaves the newer command's call open",
      async ({ operation, setup, call }) => {
        const { orderId, subject } = await setup();
        // The first scheduled command is answered; its answer is in its step record.
        const first = sagaStep();
        step = first;
        await call(orderId);
        // A newer command gets no answer.
        const second = sagaStep();
        step = second;
        answering = false;
        await expect(call(orderId)).rejects.toThrow(/did not answer/);
        const unanswered = await record(orderId, operation, subject);
        expect(unanswered.open).toBe(true);

        // The first command's attempt that stalled before opening resumes now. Its
        // step record holds an answer; it says nothing of the newer call, and is
        // refused before it calls.
        step = first;
        const late = await call(orderId).then(
          () => 'answered',
          (error: unknown) => error,
        );
        expect(await record(orderId, operation, subject)).toMatchObject({
          open: true,
          generation: unanswered.generation,
        });
        expect(late).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/a command scheduled later owns/),
          }),
        );
        // For good: retrying an attempt the saga has moved past cannot help.
        expect(late).toMatchObject({ type: 'SAGA_CALL_SUPERSEDED', nonRetryable: true });

        // Only the newer command's own answer ends it.
        step = second;
        answering = true;
        await call(orderId);
        expect((await record(orderId, operation, subject)).open).toBe(false);
      },
    );

    it.each(operations)(
      '$operation: a confirmation racing an opening cannot leave the new episode with the old age',
      async ({ operation, setup, call }) => {
        const { orderId, subject } = await setup();
        // An earlier command's call, unanswered for two hours.
        step = sagaStep();
        answering = false;
        await expect(call(orderId)).rejects.toThrow(/did not answer/);
        const earlier = await record(orderId, operation, subject);
        await runUnscoped(
          'the suite ages the call record',
          () =>
            prisma.client.$executeRaw`UPDATE saga_unconfirmed_call
            SET opened_at = opened_at - interval '7200 seconds'
            WHERE order_id = ${orderId} AND operation = ${operation} AND subject = ${subject}`,
        );

        // A newer command opens while the earlier one's late answer lands.
        step = sagaStep();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked: () => void = () => undefined;
        let holderPid = 0;
        const holding = new Promise<void>((resolve) => (locked = resolve));
        const holder = runUnscoped('a late confirmation holding the call record', () =>
          prisma.client.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT 1 FROM saga_unconfirmed_call
                WHERE order_id = ${orderId} AND operation = ${operation} AND subject = ${subject}
                FOR UPDATE`;
              const [me] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              holderPid = me!.pid;
              locked();
              await gate;
              // The earlier command's own answer, confirming its own generation.
              await tx.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
                WHERE order_id = ${orderId} AND operation = ${operation} AND subject = ${subject}
                  AND generation = ${earlier.generation} AND confirmed_at IS NULL`;
            },
            { timeout: 30_000 },
          ),
        );
        await holding;
        const opening = call(orderId).then(
          () => 'answered',
          (error: unknown) => error,
        );
        let waited = false;
        try {
          for (let elapsed = 0; elapsed <= 10_000 && !waited; elapsed += 20) {
            const [row] = await runUnscoped(
              'the suite reads lock waits',
              () =>
                prisma.client.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND pid <> ${holderPid}
                   AND query ~* ${WRITES_CALL_RECORD}`,
            );
            waited = (row?.n ?? 0) > 0;
            if (!waited) await new Promise((settle) => setTimeout(settle, 20));
          }
        } finally {
          release();
          await holder;
        }
        expect(waited).toBe(true);
        // The newer command's call gets no answer either: its episode is new.
        expect(await opening).toEqual(
          expect.objectContaining({ message: expect.stringMatching(/did not answer/) }),
        );
        const newer = await record(orderId, operation, subject);
        expect(newer.open).toBe(true);
        expect(newer.age).toBeLessThan(600);
      },
    );
  });

  // #836 r1 R2a: the hold's intent is on record before anything is sent, and an
  // empty lookup cannot end it: a create still in flight may commit after the
  // saga failed or cancelled the order (R2b, the workflow's exits, is #812).
  describe('the hold-creation intent (#836 r1 R2a)', () => {
    let creating: () => Promise<{ id: string }> = async () => ({ id: `TXN_${ulid()}` });
    let found: (orderId: string) => unknown[] = () => [];
    /** One scheduled command for every call while set; else a new one per call. */
    let retrying: SagaStep | undefined;
    /** Temporal's attempt of the scheduling (undefined: no Temporal context). */
    let attempt: number | undefined = 1;
    const hold: OrderActivities = createActivities({
      orders: wiring.orders,
      economic: {
        ...economic,
        createObligation: () => creating(),
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
        findObligations: async ({ orderId }: { orderId: string }) => found(orderId),
      } as unknown as EconomicClient,
      currentStep: () => retrying ?? sagaStep(),
      currentAttempt: () => attempt as number,
    });
    const lost = () => new Error('economic-service did not answer (socket hang up)');
    /** The deadline a workflow at the fence proposes (D-144); far ahead, never passed. */
    const DEADLINE = new Date(Date.now() + 86_400_000).toISOString();
    const refused = (code: string, status: number) =>
      new RastaError(code as never, 'refused', { internalContext: { operation: 'x', status } });
    const intentOpen = async (orderId: string) => {
      const [row] = await runUnscoped(
        'the suite reads the hold intent',
        () =>
          prisma.client.$queryRaw<{ open: boolean }[]>`
          SELECT confirmed_at IS NULL AS open FROM saga_unconfirmed_call
          WHERE order_id = ${orderId} AND operation = 'createObligation' AND subject = ${orderId}`,
      );
      return row?.open ?? null;
    };
    /** The order's own obligation as economic-service lists it. */
    const own = (orderId: string, status = 'HELD') => ({
      id: `TXN_${ulid()}`,
      organizationId: org.buyer,
      counterpartyOrganizationId: org.supplier,
      grossAmountMinor: '',
      currency: '',
      transactionType: 'MARKETPLACE_ORDER',
      sourceType: 'ORDER',
      sourceReference: orderId,
      status,
    });

    it('a timed-out create stays an alerting episode through an empty lookup and a FAILED order', async () => {
      const before = await read();
      const orderId = await place();
      creating = async () => {
        throw lost();
      };
      await expect(hold.createObligation(orderId)).rejects.toThrow(/did not answer/);
      expect(await intentOpen(orderId)).toBe(true);
      // Empty: economic-service's commit is still in flight, invisible to a read.
      found = () => [];
      expect(await hold.findObligation(orderId)).toBeNull();
      await hold.markFailed(orderId, 'hold not placed');
      expect(await intentOpen(orderId)).toBe(true);
      await age(orderId, 1);
      const after = await read();
      expect(after.UNCONFIRMED_CALL!.count).toBe(before.UNCONFIRMED_CALL!.count + 1);
      expect(after.UNCONFIRMED_CALL!.overdue).toBe(before.UNCONFIRMED_CALL!.overdue + 1);

      // A lookup that finds the order's own obligation ends it, whatever its status.
      const order = await runUnscoped('the suite reads the order terms', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
      );
      found = (id) => [
        {
          ...own(id, 'REFUNDED'),
          grossAmountMinor: order.totalAmountMinor.toString(),
          currency: order.currency,
        },
      ];
      await expect(hold.findObligation(orderId)).resolves.toMatchObject({ notHeld: true });
      expect(await intentOpen(orderId)).toBe(false);
      found = () => [];
    });

    it('a lookup that finds only a row on other terms leaves the intent open', async () => {
      const orderId = await place();
      creating = async () => {
        throw lost();
      };
      await expect(hold.createObligation(orderId)).rejects.toThrow(/did not answer/);
      found = (id) => [own(id)];
      await expect(hold.findObligation(orderId)).resolves.toMatchObject({ mismatch: true });
      expect(await intentOpen(orderId)).toBe(true);
      found = () => [];
      await runUnscoped(
        'the suite closes the intent it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE order_id = ${orderId}`,
      );
    });

    it('a refusal of a retry leaves the intent open: the first send may still claim the freed key', async () => {
      const orderId = await place();
      retrying = sagaStep();
      try {
        creating = async () => {
          throw lost();
        };
        await expect(hold.createObligation(orderId)).rejects.toThrow(/did not answer/);
        creating = async () => {
          throw refused('INSUFFICIENT_BALANCE', 422);
        };
        await expect(hold.createObligation(orderId)).rejects.toThrow();
        expect(await intentOpen(orderId)).toBe(true);
      } finally {
        retrying = undefined;
      }
      await runUnscoped(
        'the suite closes the intent it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE order_id = ${orderId}`,
      );
    });

    // #836 r2 N1 (D-135): a record that began on a retry proves no earlier send.
    // An older worker's attempt 1 sent the create without opening a record, then
    // this worker's attempt 2 opened a fresh one and was refused for balance:
    // the first send, delayed before its claim, can still claim the freed key.
    it('a refusal on a retry whose record began there leaves the intent open (an unrecorded earlier send)', async () => {
      for (const unrecorded of [2, 3, undefined]) {
        const orderId = await place();
        attempt = unrecorded;
        try {
          creating = async () => {
            throw refused('INSUFFICIENT_BALANCE', 422);
          };
          await expect(hold.createObligation(orderId)).rejects.toThrow();
          expect([unrecorded, await intentOpen(orderId)]).toEqual([unrecorded, true]);
        } finally {
          attempt = 1;
        }
      }
      await runUnscoped(
        'the suite closes the intents it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE organization_id = ${org.buyer} AND operation = 'createObligation'
            AND confirmed_at IS NULL`,
      );
    });

    it("ends with the create's own answer, or a refusal that proves nothing was held", async () => {
      const answered = await place();
      creating = async () => ({ id: `TXN_${ulid()}` });
      await hold.createObligation(answered);
      expect(await intentOpen(answered)).toBe(false);

      for (const [code, status, open] of [
        ['INSUFFICIENT_BALANCE', 422, false],
        ['BUSINESS_RULE_VIOLATION', 422, false],
        ['VALIDATION_FAILED', 400, false],
        // The replay guard answers these for a key that did commit.
        ['NOT_FOUND', 404, true],
        ['FORBIDDEN', 403, true],
        // A conflict is an attempt still in flight; a reused key may have committed.
        ['CONFLICT', 409, true],
        ['IDEMPOTENCY_KEY_REUSED', 409, true],
        // A known code under another status is not economic-service's refusal.
        ['INSUFFICIENT_BALANCE', 500, true],
      ] as const) {
        const orderId = await place();
        creating = async () => {
          throw refused(code, status);
        };
        // With the deadline a workflow at the fence proposes (D-144): the first send the
        // order row has ever counted, so the row's proof and the record's agree.
        await expect(hold.createObligation(orderId, DEADLINE)).rejects.toThrow();
        expect([code, status, await intentOpen(orderId)]).toEqual([code, status, open]);
      }
      // #836 with #812: the record closes on a refusal only where the row's proof holds
      // too. A round of a wait from before the fence (no deadline proposed), or a second
      // send the row has counted, leaves it open, even for a refusal that held nothing.
      for (const [why, deadline, claimsBefore] of [
        ['no deadline proposed', undefined, 0],
        ['an earlier send counted on the row', DEADLINE, 1],
      ] as const) {
        const orderId = await place();
        if (claimsBefore > 0) {
          await runUnscoped(
            'the suite counts an earlier send on the order',
            () =>
              prisma.client.$executeRaw`UPDATE "order" SET hold_send_claims = ${claimsBefore}
              WHERE id = ${orderId}`,
          );
        }
        creating = async () => {
          throw refused('INSUFFICIENT_BALANCE', 422);
        };
        await expect(hold.createObligation(orderId, deadline)).rejects.toThrow();
        expect([why, await intentOpen(orderId)]).toEqual([why, true]);
      }
      await runUnscoped(
        'the suite closes the intents it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE organization_id = ${org.buyer} AND operation = 'createObligation'
            AND confirmed_at IS NULL`,
      );
    });
  });

  // #836 r2 N1, D-135: until economic-service fences a late claim (D-132), nothing
  // proves an unanswered call will not still commit: a request delayed before
  // its claim can claim the key at any time, and retention starts at the claim.
  // So for all five recorded operations, no path closes a record on absence (an
  // empty lookup, a read finding nothing), a terminal order or age past
  // retention: every one stays open and alerting.
  describe('absence, a terminal order and age close no record (#836 r2 N1, D-135)', () => {
    let send: () => Error = () => new Error('economic-service did not answer (socket hang up)');
    const fail = async () => {
      throw send();
    };
    // Every send unanswered or refused for state, every read finding nothing,
    // every attempt a retry: so each activity asks and gets absence back.
    const absent: OrderActivities = createActivities({
      orders: wiring.orders,
      economic: {
        ...economic,
        createObligation: fail,
        authoriseSettlement: fail,
        settle: fail,
        refund: fail,
        resolveDispute: fail,
        readObligation: async () => null,
        findObligations: async () => [],
      } as unknown as EconomicClient,
      currentStep: sagaStep,
      currentAttempt: () => 2,
    });
    const open = async (orderId: string) =>
      runUnscoped(
        'the suite reads the call records of an order it wrote',
        () =>
          prisma.client.$queryRaw<{ operation: string; open: boolean }[]>`
          SELECT operation, confirmed_at IS NULL AS open FROM saga_unconfirmed_call
          WHERE order_id = ${orderId} ORDER BY operation`,
      );

    it('every operation stays open through empty reads, a FAILED order and two days past retention', async () => {
      const before = await read();
      const created = await place();
      const { orderId: received, transactionId: authorised } = await held();
      await asSupplier(() => wiring.orders.confirm(received));
      await asSupplier(() => wiring.orders.fulfill(received, { trackingReference: 'TRK-N1' }));
      await asBuyer(() => wiring.orders.confirmReceipt(received, {}));
      const refunding = await held();
      const releasing = await decided();

      const round = async () => {
        await expect(absent.createObligation(created)).rejects.toThrow();
        await expect(absent.findObligation(created)).resolves.toBeNull();
        await expect(absent.authoriseSettlement(received, authorised)).rejects.toThrow();
        await expect(absent.settle(received, authorised)).rejects.toThrow();
        await expect(
          absent.compensate(refunding.orderId, refunding.transactionId, 'order cancelled'),
        ).rejects.toThrow();
        await expect(
          absent.resolveObligationDispute(
            releasing.orderId,
            releasing.transactionId,
            releasing.disputeId,
            settle.resolution,
          ),
        ).rejects.toThrow();
      };
      await round();
      await absent.markFailed(created, 'hold not placed');
      // Past economic-service's retention (ECONOMIC_IDEMPOTENCY_TTL_HOURS, 24 h)
      // plus a day's margin, the step 7 #836 r2 N1 found unsafe.
      for (const orderId of [created, received, refunding.orderId, releasing.orderId]) {
        await age(orderId, 2);
      }
      // A refusal for state is what makes an activity read; the read finds nothing.
      send = () =>
        new RastaError('INVALID_STATE_TRANSITION' as never, 'refused', {
          internalContext: { operation: 'x', status: 409 },
        });
      await round();

      expect(await open(created)).toEqual([{ operation: 'createObligation', open: true }]);
      expect(await open(received)).toEqual([
        { operation: 'authoriseSettlement', open: true },
        { operation: 'settle', open: true },
      ]);
      expect(await open(refunding.orderId)).toEqual([{ operation: 'compensate', open: true }]);
      expect(await open(releasing.orderId)).toEqual([
        { operation: 'resolveObligationDispute', open: true },
      ]);
      const after = await read();
      expect(after.UNCONFIRMED_CALL!.overdue).toBe(before.UNCONFIRMED_CALL!.overdue + 4);
      expect(after.DISPUTE_RELEASE!.overdue).toBe(before.DISPUTE_RELEASE!.overdue + 1);

      await runUnscoped(
        'the suite closes the records it opened',
        () =>
          prisma.client.$executeRaw`UPDATE saga_unconfirmed_call SET confirmed_at = now()
          WHERE order_id IN (${created}, ${received}, ${refunding.orderId}, ${releasing.orderId})`,
      );
    });
  });
});
