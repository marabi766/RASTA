import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
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
    (await store.unconfirmedCalls(graceSeconds)).calls.find((row) => row.operation === OPERATION)
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

    const firstCall = await wiring.orders.openSagaCall(first, OPERATION, 'DSP_1');
    const secondCall = await wiring.orders.openSagaCall(second, OPERATION, 'DSP_2');
    expect(await open()).toBe(before + 2);
    // Within its grace it is a call in flight.
    expect(await open(UNCONFIRMED_CALL_GRACE_SECONDS)).toBe(beforeGrace);

    await wiring.orders.confirmSagaCall(first, OPERATION, 'DSP_1', firstCall);
    expect(await open()).toBe(before + 1);
    await wiring.orders.confirmSagaCall(second, OPERATION, 'DSP_2', secondCall);
    expect(await open()).toBe(before);
  });

  it('a later attempt opens it again; another dispute is its own (#769 r1 F3)', async () => {
    const before = await open();
    const order = await place(org.buyer, org.supplier);

    const first = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_A', first);
    expect(await open()).toBe(before);

    const second = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    expect(second).toBeGreaterThan(first);
    expect(await open()).toBe(before + 1);

    const other = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_B');
    expect(await open()).toBe(before + 2);
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_A', second);
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_B', other);
    expect(await open()).toBe(before);
  });

  it('only the latest opening confirms; concurrent openings each get their own', async () => {
    const before = await open();
    const order = await place(org.buyer, org.supplier);

    const generations = await Promise.all(
      [1, 2, 3, 4].map(() => wiring.orders.openSagaCall(order, OPERATION, 'DSP_G')),
    );
    expect(new Set(generations).size).toBe(4);
    const newest = Math.max(...generations);

    for (const stale of generations.filter((generation) => generation !== newest)) {
      await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_G', stale);
    }
    expect(await open()).toBe(before + 1);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_G', newest);
    expect(await open()).toBe(before);
  });

  it('confirming names the call: another subject or tenant stays open', async () => {
    const before = await open();
    const order = await place(org.buyer, org.supplier);
    const call = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_X');

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_Y', call);
    await wiring.orders.confirmSagaCall(
      { id: order.id, organizationId: other.buyer },
      OPERATION,
      'DSP_X',
      call,
    );
    expect(await open()).toBe(before + 1);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_X', call);
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

  // #769 r1 F1: what the sampler orders replicas' reads by.
  it('brackets its snapshot by the database clock, with no call as with some', async () => {
    const empty = await store.unconfirmedCalls(1_000_000);
    expect(empty.calls).toEqual([]);
    expect(empty.startedAt).toBeLessThanOrEqual(empty.finishedAt);
    const [{ now }] = await prisma.client.$queryRaw<{ now: number }[]>`
      SELECT EXTRACT(EPOCH FROM clock_timestamp())::float AS now`;
    expect(empty.finishedAt).toBeLessThanOrEqual(now);
    expect(now - empty.startedAt).toBeLessThan(60);
  });

  /**
   * #769 r1 F2: what was already owed when the table arrived, by the migration's own
   * statement, which is also what the runbook runs again.
   */
  describe('the backfill', () => {
    const migration = readFileSync(
      join(__dirname, '../prisma/migrations/20261105130000_saga_unconfirmed_call/migration.sql'),
      'utf8',
    );
    const backfill = migration.slice(
      migration.indexOf('-- BACKFILL BEGIN'),
      migration.indexOf('-- BACKFILL END'),
    );

    async function decided(
      status: 'OPEN' | 'RESOLVED_REFUND' | 'RESOLVED_SETTLE',
      orderStatus: string,
    ) {
      const order = await place(org.buyer, org.supplier);
      const id = `DSP_${ulid()}`;
      await runUnscoped('the test writes an order as an earlier release left it', async () => {
        // Every field the table's checks ask of any status; only the status matters here.
        const moveTo = (to: string) =>
          prisma.client.$executeRawUnsafe(
            `UPDATE "order" SET status = $2::"OrderStatus", economic_transaction_id = 'TXN_' || id,
               economic_settlement_id = 'STL_' || id, completed_at = now(), cancelled_at = now(),
               receipt_confirmed_at = now(), receipt_confirmed_by = 'USR-T',
               cancellation_reason = 'test', cancellation_cause = 'BUYER'
             WHERE id = $1`,
            order.id,
            to,
          );
        await moveTo('FUNDS_HELD');
        await prisma.client.orderDispute.create({
          data: {
            id,
            organizationId: order.organizationId,
            orderId: order.id,
            reason: 'it does not fit the drawing',
            raisedBy: 'USR-T',
            status,
            ...(status === 'OPEN'
              ? {}
              : {
                  resolution: 'decided',
                  resolvedAt: new Date(),
                  resolvedBy: 'USR-T',
                  responsibility: 'UNDETERMINED',
                }),
          },
        });
        await moveTo(orderStatus);
      });
      return { ...order, disputeId: id };
    }

    const receipt = (
      order: { id: string; organizationId: string },
      at: string,
      activity = OPERATION,
    ) =>
      runUnscoped('the test writes the receipt an earlier release left', () =>
        prisma.client.sagaStep.create({
          data: {
            organizationId: order.organizationId,
            orderId: order.id,
            stepKey: `wf/run/${ulid()}`,
            activity,
            appliedAt: new Date(at),
          },
        }),
      );

    const rowOf = (order: { id: string }) =>
      runUnscoped('the test reads what the backfill wrote', () =>
        prisma.client.sagaUnconfirmedCall.findMany({ where: { orderId: order.id } }),
      );

    it('records what no proof ends, and it counts at once, with no saga left', async () => {
      const held = await decided('RESOLVED_REFUND', 'CANCELLING');
      const resumed = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      const before = await open();

      await prisma.client.$executeRawUnsafe(backfill);

      expect(await rowOf(held)).toMatchObject([
        {
          organizationId: held.organizationId,
          operation: OPERATION,
          subject: held.disputeId,
          confirmedAt: null,
        },
      ]);
      expect(await rowOf(resumed)).toHaveLength(1);
      expect(await open()).toBeGreaterThanOrEqual(before + 2);
    });

    it('a receipt from before the decision is another dispute’s: no proof', async () => {
      const order = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(order, '2020-01-01T00:00:00Z');

      await prisma.client.$executeRawUnsafe(backfill);

      expect(await rowOf(order)).toHaveLength(1);
    });

    it('a later receipt of another step is no proof', async () => {
      const order = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(order, '2999-01-01T00:00:00Z', 'disputeObligation');

      await prisma.client.$executeRawUnsafe(backfill);

      expect(await rowOf(order)).toHaveLength(1);
    });

    it('leaves what is proven ended', async () => {
      const completed = await decided('RESOLVED_SETTLE', 'COMPLETED');
      const cancelled = await decided('RESOLVED_REFUND', 'CANCELLED');
      const released = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(released, '2999-01-01T00:00:00Z');

      await prisma.client.$executeRawUnsafe(backfill);

      for (const order of [completed, cancelled, released]) {
        expect(await rowOf(order)).toEqual([]);
      }
    });

    it('a dispute told after the receipt is not answered by it', async () => {
      const order = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(order, '2999-01-01T00:00:00Z');
      await receipt(order, '3000-01-01T00:00:00Z', 'disputeObligation');
      const answered = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(answered, '2999-01-01T00:00:00Z');
      await receipt(answered, '3000-01-01T00:00:00Z', 'disputeObligation');
      await receipt(answered, '3001-01-01T00:00:00Z');

      await prisma.client.$executeRawUnsafe(backfill);

      expect(await rowOf(order)).toHaveLength(1);
      expect(await rowOf(answered)).toEqual([]);
    });

    it('records a dispute still open, its saga perhaps gone, counted once decided', async () => {
      const order = await decided('OPEN', 'DISPUTED');
      await prisma.client.$executeRawUnsafe(backfill);
      const before = await open();

      expect(await rowOf(order)).toHaveLength(1);
      await runUnscoped('the test decides it, with no saga left to call', () =>
        prisma.client.orderDispute.update({
          where: { id: order.disputeId },
          data: {
            status: 'RESOLVED_REFUND',
            resolution: 'decided',
            resolvedAt: new Date(),
            resolvedBy: 'USR-T',
            responsibility: 'UNDETERMINED',
          },
        }),
      );

      expect(await open()).toBe(before + 1);
    });

    it('run again, it leaves what the code has done since', async () => {
      const order = await decided('RESOLVED_REFUND', 'CANCELLING');
      await prisma.client.$executeRawUnsafe(backfill);
      const generation = await wiring.orders.openSagaCall(order, OPERATION, order.disputeId);
      await wiring.orders.confirmSagaCall(order, OPERATION, order.disputeId, generation);

      await prisma.client.$executeRawUnsafe(backfill);

      expect(await rowOf(order)).toMatchObject([{ generation, confirmedAt: expect.any(Date) }]);
    });
  });
});
