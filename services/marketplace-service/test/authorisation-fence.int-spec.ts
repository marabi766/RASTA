import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createActivities } from '../src/temporal/activities';
import type { EconomicClient } from '../src/economic/economic.client';
import { ORDER_HOLD_SEND_DEADLINE_MS, ORDER_HOLD_WAIT_MS } from '../src/config/operation-budgets';
import type { ExtendedPrismaClient, PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  resolveOpenDispute,
  sagaStep,
  tenants,
  waitFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * FU-178, D-138: an authorisation and a party's dispute, on real PostgreSQL rows.
 *
 * Whichever gets the order's row first, no authorisation leaves after a dispute
 * committed. Each interleaving is held open with a promise and confirmed from the
 * database (`pg_blocking_pids`), not by waiting and hoping. The service's real
 * transactions run on both sides; only `EconomicClient` is stubbed.
 *
 * `sentWhile` is the status another connection reads while the send is out, which
 * is what the order had committed at that moment.
 */
describe('an authorisation against a concurrent dispute (FU-178, D-138)', () => {
  jest.setTimeout(60_000);

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

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-FNC-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-FNC-S' }, fn);
  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['SYSTEM_ADMIN'], userId: 'USR-FNC-OPS' }, fn);

  const statusOf = async (orderId: string): Promise<string> =>
    (
      await runUnscoped('the suite reads what the order has committed', () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
      )
    ).status;

  /** An order the buyer confirmed receipt of, with its obligation recorded. */
  async function receiptConfirmed(): Promise<{ orderId: string; transactionId: string }> {
    const transactionId = `TXN_${ulid()}`;
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '500000' });
    const { id: orderId } = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('FNC')),
    );
    await asBuyer(async () => {
      await wiring.orders.markFundsHeld(orderId, transactionId, sagaStep());
    });
    await asSupplier(async () => {
      await wiring.orders.confirm(orderId);
      await wiring.orders.fulfill(orderId, {});
    });
    await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
    return { orderId, transactionId };
  }

  /** The real activity over a stub economic-service recording what the order had committed. */
  function authoriser(
    orderId: string,
    options: { send?: () => Promise<void>; attempt?: number; read?: () => unknown } = {},
  ) {
    const sentWhile: string[] = [];
    const economic = {
      authoriseSettlement: async () => {
        sentWhile.push(await statusOf(orderId));
        await options.send?.();
      },
      readObligation: async () => (options.read ?? (() => ({ status: 'HELD' })))(),
    } as unknown as EconomicClient;
    const step = sagaStep();
    const activities = createActivities({
      orders: wiring.orders,
      economic,
      currentStep: () => step,
      currentAttempt: () => options.attempt ?? 1,
    });
    return { activities, sentWhile };
  }

  /** How many sessions wait behind a row lock on `order` right now. The suite runs alone. */
  async function blockedOnOrders(): Promise<number> {
    const rows = await prisma.client.$queryRaw<{ blocked: bigint }[]>`
      SELECT count(*) AS blocked
      FROM pg_stat_activity
      WHERE cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%"order"%'
        AND datname = current_database()
    `;
    return Number(rows[0]?.blocked ?? 0);
  }

  function gate(): { opened: Promise<void>; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  it('a dispute in progress: the authorisation waits for its commit, reads it and sends nothing', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    const { activities, sentWhile } = authoriser(orderId);
    const commit = gate();
    const written = gate();

    // The real command, stopped as its transaction's last statement.
    const dispute = asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' }, async () => {
        written.open();
        await commit.opened;
      }),
    );
    await written.opened;

    const authorisation = activities.authoriseSettlement(orderId, transactionId);
    await waitFor('the authorisation to wait behind the dispute', async () =>
      (await blockedOnOrders()) > 0 ? true : null,
    );
    // Uncommitted, so any read outside the lock would still see an eligible order.
    expect(await statusOf(orderId)).toBe('RECEIPT_CONFIRMED');
    expect(sentWhile).toEqual([]);

    commit.open();
    await dispute;

    await expect(authorisation).resolves.toEqual({
      fenced: true,
      status: 'DISPUTED',
      inDoubt: false,
    });
    expect(sentWhile).toEqual([]);
  });

  it('a send in progress: the dispute waits for its answer, and commits after it', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    const answer = gate();
    const sending = gate();
    const { activities, sentWhile } = authoriser(orderId, {
      send: async () => {
        sending.open();
        await answer.opened;
      },
    });

    const authorisation = activities.authoriseSettlement(orderId, transactionId);
    await sending.opened;

    let disputed = false;
    const dispute = asBuyer(() =>
      wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' }),
    ).then((view) => {
      disputed = true;
      return view;
    });
    await waitFor('the dispute to wait behind the send', async () =>
      (await blockedOnOrders()) > 0 ? true : null,
    );
    expect(disputed).toBe(false);
    expect(await statusOf(orderId)).toBe('RECEIPT_CONFIRMED');

    answer.open();

    await expect(authorisation).resolves.toBeUndefined();
    await expect(dispute).resolves.toMatchObject({ status: 'DISPUTED' });
    expect(sentWhile).toEqual(['RECEIPT_CONFIRMED']);
    expect(await statusOf(orderId)).toBe('DISPUTED');
  });

  it('raced with no coordination: never a send after the dispute committed', async () => {
    for (let round = 0; round < 12; round += 1) {
      const { orderId, transactionId } = await receiptConfirmed();
      const { activities, sentWhile } = authoriser(orderId);
      let answered: unknown;
      const send = async (): Promise<void> => {
        // Spread across the dispute's own transaction, so the rounds land on both sides.
        await new Promise((resolve) => setTimeout(resolve, round * 4));
        answered = await activities.authoriseSettlement(orderId, transactionId);
      };
      const dispute = async (): Promise<void> => {
        await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' }));
      };

      await Promise.all(
        (round % 2 === 0 ? [send, dispute] : [dispute, send]).map((start) => start()),
      );

      expect(sentWhile).not.toContain('DISPUTED');
      expect(await statusOf(orderId)).toBe('DISPUTED');
      // The answer agrees with what happened: authorised only if it was sent.
      if (answered === undefined) expect(sentWhile).toEqual(['RECEIPT_CONFIRMED']);
      else expect(sentWhile).toEqual([]);
    }
  });

  it('decided REFUND: CANCELLING is fenced as well', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it never arrived' }));
    await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'REFUND',
        resolution: 'the supplier agrees',
        responsibility: 'SUPPLIER',
      }),
    );
    const { activities, sentWhile } = authoriser(orderId);

    await expect(activities.authoriseSettlement(orderId, transactionId)).resolves.toEqual({
      fenced: true,
      status: 'CANCELLING',
      inDoubt: false,
    });
    expect(sentWhile).toEqual([]);
  });

  it('decided SETTLE back to RECEIPT_CONFIRMED: the same call goes out again', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it arrived late' }));
    const fenced = authoriser(orderId);
    await expect(fenced.activities.authoriseSettlement(orderId, transactionId)).resolves.toEqual({
      fenced: true,
      status: 'DISPUTED',
      inDoubt: false,
    });
    await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'SETTLE',
        resolution: 'it was not late',
        responsibility: 'BUYER',
      }),
    );
    const again = authoriser(orderId);

    await expect(
      again.activities.authoriseSettlement(orderId, transactionId),
    ).resolves.toBeUndefined();
    expect(again.sentWhile).toEqual(['RECEIPT_CONFIRMED']);
  });

  it('a retry of a fenced step answers what its first attempt answered, from the record', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' }));
    const options = { attempt: 1 };
    const { activities, sentWhile } = authoriser(orderId, options);
    const first = await activities.authoriseSettlement(orderId, transactionId);
    expect(first).toMatchObject({ fenced: true, inDoubt: false });

    // The order may have moved since; attempt 2 without the record would be in doubt.
    options.attempt = 2;
    await expect(activities.authoriseSettlement(orderId, transactionId)).resolves.toEqual(first);
    expect(sentWhile).toEqual([]);
  });

  it('in doubt behind a dispute: reconciled from the obligation, with no send', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' }));

    const effect = authoriser(orderId, {
      attempt: 2,
      read: () => ({ status: 'PENDING_SETTLEMENT' }),
    });
    await expect(
      effect.activities.authoriseSettlement(orderId, transactionId),
    ).resolves.toBeUndefined();
    expect(effect.sentWhile).toEqual([]);

    const none = authoriser(orderId, { attempt: 2 });
    await expect(none.activities.authoriseSettlement(orderId, transactionId)).resolves.toEqual({
      fenced: true,
      status: 'DISPUTED',
      inDoubt: true,
    });
    expect(none.sentWhile).toEqual([]);
  });

  it('a send that fails releases the row, and the dispute goes through', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    const { activities } = authoriser(orderId, {
      send: async () => {
        throw RastaError.upstreamUnavailable('economic-service');
      },
    });

    await expect(activities.authoriseSettlement(orderId, transactionId)).rejects.toMatchObject({
      type: 'UPSTREAM_UNAVAILABLE',
    });
    await expect(
      asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'it arrived broken' })),
    ).resolves.toMatchObject({ status: 'DISPUTED' });
  });

  it('a row held past the wait: the attempt fails with nothing sent, and can be retried', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    const { activities, sentWhile } = authoriser(orderId);
    const release = gate();
    const holding = gate();
    const holder = prisma.client.$transaction(
      async (tx) => {
        await wiring.repository.lockOrder(tx as ExtendedPrismaClient, orderId);
        holding.open();
        // Bounded, so a hold that never gave up fails the assertions below, not the run.
        await Promise.race([
          release.opened,
          new Promise((resolve) => setTimeout(resolve, ORDER_HOLD_WAIT_MS + 2_000)),
        ]);
      },
      { timeout: ORDER_HOLD_WAIT_MS + 5_000 },
    );
    await holding.opened;

    const started = Date.now();
    const failed = await activities
      .authoriseSettlement(orderId, transactionId)
      .then(() => 'answered')
      .catch((error: Error) => error);
    release.open();
    await holder;

    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toMatchObject({ nonRetryable: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(ORDER_HOLD_WAIT_MS - 100);
    expect(sentWhile).toEqual([]);
  });

  it('a long wait and then a slow send still fit the hold’s transaction, and answer', async () => {
    const { orderId, transactionId } = await receiptConfirmed();
    const { activities, sentWhile } = authoriser(orderId, {
      send: () => new Promise((resolve) => setTimeout(resolve, ORDER_HOLD_SEND_DEADLINE_MS)),
    });
    const holder = prisma.client.$transaction(
      async (tx) => {
        await wiring.repository.lockOrder(tx as ExtendedPrismaClient, orderId);
        await new Promise((resolve) => setTimeout(resolve, ORDER_HOLD_WAIT_MS - 1_000));
      },
      { timeout: ORDER_HOLD_WAIT_MS + 5_000 },
    );

    await expect(activities.authoriseSettlement(orderId, transactionId)).resolves.toBeUndefined();
    await holder;
    expect(sentWhile).toEqual(['RECEIPT_CONFIRMED']);
  });

  it('the hold on an order that does not exist is refused, and runs nothing', async () => {
    const fn = jest.fn();
    await expect(
      asBuyer(() => wiring.orders.whileOrderHeld(`ORD_${ulid()}`, fn)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fn).not.toHaveBeenCalled();
  });
});
