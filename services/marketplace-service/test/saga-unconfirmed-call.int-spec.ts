import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire } from './helpers';

/** The durable record of unconfirmed economic calls (FU-104), against the real database. */
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

  /** The order's open calls as the store returns them; other specs share the database. */
  const open = async (order: { id: string }) =>
    (await store.openUnconfirmedCalls(1_000_000)).calls.filter((row) => row.orderId === order.id);

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, other.buyer, other.supplier]);
    await prisma.onModuleDestroy();
  });

  it('returns what a reader needs of an open call, across tenants, until it is confirmed', async () => {
    const first = await place(org.buyer, org.supplier);
    const second = await place(other.buyer, other.supplier);

    const firstCall = await wiring.orders.openSagaCall(first, OPERATION, 'DSP_1');
    const secondCall = await wiring.orders.openSagaCall(second, OPERATION, 'DSP_2');
    expect(await open(first)).toEqual([
      {
        organizationId: first.organizationId,
        orderId: first.id,
        operation: OPERATION,
        subject: 'DSP_1',
        generation: firstCall,
        openedAt: expect.any(Date),
      },
    ]);
    expect(await open(second)).toMatchObject([{ organizationId: second.organizationId }]);

    await wiring.orders.confirmSagaCall(first, OPERATION, 'DSP_1', firstCall);
    expect(await open(first)).toEqual([]);
    expect(await open(second)).toHaveLength(1);
    await wiring.orders.confirmSagaCall(second, OPERATION, 'DSP_2', secondCall);
    expect(await open(second)).toEqual([]);
  });

  it('lists the oldest first and says when it stopped at the limit', async () => {
    const order = await place(org.buyer, org.supplier);
    for (const subject of ['DSP_L1', 'DSP_L2', 'DSP_L3']) {
      await wiring.orders.openSagaCall(order, OPERATION, subject);
    }
    await runUnscoped('the test ages a row, so that the order is not the insert order', () =>
      prisma.client.sagaUnconfirmedCall.update({
        where: {
          organizationId_orderId_operation_subject: {
            organizationId: order.organizationId,
            orderId: order.id,
            operation: OPERATION,
            subject: 'DSP_L3',
          },
        },
        data: { openedAt: new Date('2000-01-01T00:00:00Z') },
      }),
    );
    const all = await store.openUnconfirmedCalls(1_000_000);
    expect(all.more).toBe(false);
    expect(all.calls.length).toBeGreaterThanOrEqual(3);

    const exact = await store.openUnconfirmedCalls(all.calls.length);
    expect(exact).toEqual(all);

    const cut = await store.openUnconfirmedCalls(all.calls.length - 1);
    expect(cut.more).toBe(true);
    expect(cut.calls).toEqual(all.calls.slice(0, -1));

    const oldest = await store.openUnconfirmedCalls(1);
    expect(oldest.calls[0]?.openedAt.getTime()).toBeLessThanOrEqual(
      new Date('2000-01-01T00:00:00Z').getTime(),
    );

    for (const call of await open(order)) {
      await wiring.orders.confirmSagaCall(order, OPERATION, call.subject, call.generation);
    }
  });

  it('a later attempt opens it again; another dispute is its own (#769 r1 F3)', async () => {
    const order = await place(org.buyer, org.supplier);

    const first = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_A', first);
    expect(await open(order)).toEqual([]);

    const second = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_A');
    expect(second).toBeGreaterThan(first);
    expect(await open(order)).toHaveLength(1);

    const another = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_B');
    expect(await open(order)).toHaveLength(2);
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_A', second);
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_B', another);
    expect(await open(order)).toEqual([]);
  });

  it('only the latest opening confirms; concurrent openings each get their own', async () => {
    const order = await place(org.buyer, org.supplier);

    const generations = await Promise.all(
      [1, 2, 3, 4].map(() => wiring.orders.openSagaCall(order, OPERATION, 'DSP_G')),
    );
    expect(new Set(generations).size).toBe(4);
    const newest = Math.max(...generations);

    for (const stale of generations.filter((generation) => generation !== newest)) {
      await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_G', stale);
    }
    expect(await open(order)).toMatchObject([{ generation: newest }]);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_G', newest);
    expect(await open(order)).toEqual([]);
  });

  it('confirming names the call: another subject, operation, order or tenant stays open', async () => {
    const order = await place(org.buyer, org.supplier);
    const sibling = await place(org.buyer, org.supplier);
    const call = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_X');
    const siblingCall = await wiring.orders.openSagaCall(sibling, OPERATION, 'DSP_X');
    const otherOperation = await wiring.orders.openSagaCall(order, 'disputeObligation', 'DSP_X');
    expect([call, otherOperation, siblingCall]).toEqual([call, call, call]);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_Y', call);
    await wiring.orders.confirmSagaCall(
      { id: order.id, organizationId: other.buyer },
      OPERATION,
      'DSP_X',
      call,
    );
    expect(await open(order)).toHaveLength(2);

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_X', call);
    expect(await open(order)).toMatchObject([{ operation: 'disputeObligation' }]);
    expect(await open(sibling)).toHaveLength(1);

    await wiring.orders.confirmSagaCall(order, 'disputeObligation', 'DSP_X', otherOperation);
    await wiring.orders.confirmSagaCall(sibling, OPERATION, 'DSP_X', siblingCall);
  });

  it('a confirmation repeated leaves the first one standing', async () => {
    const order = await place(org.buyer, org.supplier);
    const call = await wiring.orders.openSagaCall(order, OPERATION, 'DSP_R');
    const read = () =>
      runUnscoped('the test reads when it was confirmed', () =>
        prisma.client.sagaUnconfirmedCall.findFirstOrThrow({ where: { orderId: order.id } }),
      );
    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_R', call);
    const first = await read();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await wiring.orders.confirmSagaCall(order, OPERATION, 'DSP_R', call);

    expect((await read()).confirmedAt).toEqual(first.confirmedAt);
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

  /**
   * #769 r1 F2, r2 F2: what was already owed when the table arrived, by the migration's
   * own statement, which is also what the runbook runs again. Only the order's end
   * ends a dispute: no receipt and no time says which dispute it answered.
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
      alsoDisputed: string[] = [],
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
               cancellation_reason = 'test', cancellation_cause = 'BUYER',
               failure_reason = 'test'
             WHERE id = $1`,
            order.id,
            to,
          );
        await moveTo('FUNDS_HELD');
        await disputeOn(order, id, status, new Date());
        for (const earlier of alsoDisputed) {
          await disputeOn(order, earlier, 'RESOLVED_REFUND', new Date());
        }
        await moveTo(orderStatus);
      });
      return { ...order, disputeId: id };
    }

    const disputeOn = (
      order: { id: string; organizationId: string },
      id: string,
      status: 'OPEN' | 'RESOLVED_REFUND' | 'RESOLVED_SETTLE',
      resolvedAt: Date,
    ) =>
      runUnscoped('the test writes a dispute as an earlier decision left it', () =>
        prisma.client.orderDispute.create({
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
                  resolvedAt,
                  resolvedBy: 'USR-T',
                  responsibility: 'UNDETERMINED',
                }),
          },
        }),
      );

    const receipt = (order: { id: string; organizationId: string }, at: Date) =>
      runUnscoped('the test writes the receipt an earlier release left', () =>
        prisma.client.sagaStep.create({
          data: {
            organizationId: order.organizationId,
            orderId: order.id,
            stepKey: `wf/run/${ulid()}`,
            activity: OPERATION,
            appliedAt: at,
          },
        }),
      );

    const subjects = async (order: { id: string }) =>
      (
        await runUnscoped('the test reads what the backfill wrote', () =>
          prisma.client.sagaUnconfirmedCall.findMany({ where: { orderId: order.id } }),
        )
      )
        .map((row) => row.subject)
        .sort();

    const run = () => prisma.client.$executeRawUnsafe(backfill);

    // The four scenarios of #769 r2 F2, by the instants it names.
    const T = Date.parse('2026-11-05T12:00:00Z');
    const at = (seconds: number) => new Date(T + seconds * 1000);

    it('a legacy decided dispute with no receipt, its saga closed, is on record', async () => {
      const order = await decided('RESOLVED_REFUND', 'CANCELLING');

      await run();

      expect(await open(order)).toEqual([
        {
          organizationId: order.organizationId,
          orderId: order.id,
          operation: OPERATION,
          subject: order.disputeId,
          generation: 1,
          openedAt: expect.any(Date),
        },
      ]);
    });

    it('an open dispute, its saga dead, is on record', async () => {
      const order = await decided('OPEN', 'DISPUTED');

      await run();

      expect(await subjects(order)).toEqual([order.disputeId]);
    });

    it('a newer dispute decided by a clock behind an older receipt is on record', async () => {
      const order = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      await receipt(order, at(0));
      // Mirrored at +20, decided at +30 by an API clock 60 seconds behind.
      const newer = `DSP_${ulid()}`;
      await disputeOn(order, newer, 'RESOLVED_REFUND', at(-30));

      await run();

      expect(await subjects(order)).toEqual([order.disputeId, newer].sort());
    });

    it('a newer dispute still held is on record, whatever older receipt arrives late', async () => {
      const order = await decided('RESOLVED_SETTLE', 'CONFIRMED');
      const newer = `DSP_${ulid()}`;
      await disputeOn(order, newer, 'RESOLVED_REFUND', at(0));
      await receipt(order, at(10));

      await run();

      expect(await subjects(order)).toEqual([order.disputeId, newer].sort());
    });

    it.each(['COMPLETED', 'CANCELLED'])(
      'leaves a dispute of a %s order: it is ended',
      async (end) => {
        const order = await decided('RESOLVED_SETTLE', end, [`DSP_${ulid()}`]);

        await run();

        expect(await subjects(order)).toEqual([]);
      },
    );

    it.each([
      'PENDING',
      'FUNDS_HELD',
      'CONFIRMED',
      'AWAITING_RECEIPT_CONFIRMATION',
      'RECEIPT_CONFIRMED',
      'SETTLING',
      'DISPUTED',
      'CANCELLING',
      'FAILED',
    ])('a %s order proves nothing: its dispute is on record', async (status) => {
      const order = await decided('RESOLVED_SETTLE', status);

      await run();

      expect(await subjects(order)).toEqual([order.disputeId]);
    });

    it('run again, it leaves what the code has done since', async () => {
      const closed = await decided('RESOLVED_REFUND', 'CANCELLING');
      const reopened = await decided('RESOLVED_REFUND', 'CANCELLING');
      await run();
      const generation = await wiring.orders.openSagaCall(closed, OPERATION, closed.disputeId);
      await wiring.orders.confirmSagaCall(closed, OPERATION, closed.disputeId, generation);
      const newest = await wiring.orders.openSagaCall(reopened, OPERATION, reopened.disputeId);

      await run();

      const row = (order: { id: string }) =>
        runUnscoped('the test reads what the rerun left', () =>
          prisma.client.sagaUnconfirmedCall.findMany({ where: { orderId: order.id } }),
        );
      expect(await row(closed)).toMatchObject([{ generation, confirmedAt: expect.any(Date) }]);
      expect(await row(reopened)).toMatchObject([{ generation: newest, confirmedAt: null }]);
    });
  });
});
