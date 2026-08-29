import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * What happens when two requests arrive at once.
 *
 * ADR-041 § 2 makes a specific claim — that `offer.availableQuantity` is real
 * and enforced — and this file is what entitles the service to make it. Without
 * the row lock in `place()`, both requests read the same availability and both
 * succeed; the `CHECK (available_quantity >= 0)` then catches the second
 * write, which is the second line of defence rather than the first.
 *
 * The other race here is the one `Idempotency-Key` exists for: a client
 * retrying a POST it never saw the answer to.
 */
describe('concurrency (real database)', () => {
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

  const asBuyer = <T>(fn: () => Promise<T>, organizationId = org.buyer) =>
    asActor({ organizationId, roles: ['PROCUREMENT_USER'], userId: 'USR-BUYER' }, fn);

  // -------------------------------------------------------------------------

  it('never sells more than the offer has, however many buyers arrive at once', async () => {
    // Ten concurrent orders for three units each, against nine available.
    // Exactly three can succeed; the rest must be refused rather than taking
    // the offer negative.
    const { offerId } = await publishOffer(wiring, org.supplier, {
      availableQuantity: 9,
      unitPriceMinor: '10000',
    });

    const attempts = Array.from({ length: 10 }, (_, i) =>
      asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId, quantity: 3 }] }, key(`race-${i}`)),
      ).then(
        (order) => ({ ok: true as const, order }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.ok);

    expect(succeeded).toHaveLength(3);

    const offer = await runUnscoped('the suite verifies the offer was not oversold', () =>
      prisma.client.offer.findUnique({ where: { id: offerId } }),
    );
    // The number that makes the claim provable: never negative, and exactly
    // what nine minus three lots of three leaves.
    expect(offer?.availableQuantity).toBe(0);
  });

  it('refuses the overselling write at the database too, not only in code', async () => {
    // The check the row lock is supposed to make unreachable. Asserted anyway,
    // because a defence that has never been observed working is a claim.
    const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 1 });

    await expect(
      runUnscoped('the suite attempts the write the lock is meant to prevent', () =>
        prisma.client.$executeRawUnsafe(
          `UPDATE "offer" SET available_quantity = available_quantity - 5 WHERE id = $1`,
          offerId,
        ),
      ),
    ).rejects.toThrow(/ck_offer_available_non_negative/);
  });

  it('lets two orders for different offers proceed in parallel', async () => {
    // The lock must not serialise unrelated purchases. Sorted lock order is
    // what makes this safe rather than deadlock-prone.
    const first = await publishOffer(wiring, org.supplier, { availableQuantity: 5 });
    const second = await publishOffer(wiring, org.supplier, { availableQuantity: 5 });

    const [a, b] = await Promise.all([
      asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId: first.offerId, quantity: 2 }] }, key('par-a')),
      ),
      asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId: second.offerId, quantity: 2 }] }, key('par-b')),
      ),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(a.status).toBe('PENDING');
    expect(b.status).toBe('PENDING');
  });

  it('does not deadlock when two multi-line orders overlap in the opposite order', async () => {
    // Both orders touch the same two offers, requested in opposite sequence.
    // `lockOffers` sorts the ids, so both transactions take the locks in the
    // same order and neither can wait on the other.
    const first = await publishOffer(wiring, org.supplier, { availableQuantity: 10 });
    const second = await publishOffer(wiring, org.supplier, { availableQuantity: 10 });

    const results = await Promise.all([
      asBuyer(() =>
        wiring.orders.place(
          {
            lines: [
              { offerId: first.offerId, quantity: 1 },
              { offerId: second.offerId, quantity: 1 },
            ],
          },
          key('dl-a'),
        ),
      ),
      asBuyer(() =>
        wiring.orders.place(
          {
            lines: [
              { offerId: second.offerId, quantity: 1 },
              { offerId: first.offerId, quantity: 1 },
            ],
          },
          key('dl-b'),
        ),
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.id)).size).toBe(2);
  });

  it('prices at the offer’s current price, not the one the buyer last saw', async () => {
    // A stale price is not honoured. The buyer's client may have been showing
    // the old figure; the order is created at what the catalogue holds now,
    // and the line records which version that was.
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });

    await asActor({ organizationId: org.supplier, roles: ['SUPPLIER'] }, () =>
      wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '175000' }),
    );

    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, key('stale')),
    );

    expect(order.lines[0]?.unitPriceMinor).toBe('175000');
    expect(order.totalAmountMinor).toBe('350000');
    // Version 2, so an auditor can find the exact repricing this order bought
    // under in `offer_price_history`.
    expect(order.lines[0]?.offerVersion).toBe(2);

    const history = await runUnscoped('the suite reads the price history it produced', () =>
      prisma.client.offerPriceHistory.findMany({
        where: { offerId },
        orderBy: { version: 'asc' },
      }),
    );
    expect(history.map((row) => row.unitPriceMinor)).toEqual([100_000n, 175_000n]);
  });

  it('leaves an order already placed at the price it agreed to', async () => {
    // A supplier cannot reprice work already sold.
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('frozen')),
    );

    await asActor({ organizationId: org.supplier, roles: ['SUPPLIER'] }, () =>
      wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '999999' }),
    );

    const after = await asBuyer(() => wiring.orders.get(order.id));
    expect(after.totalAmountMinor).toBe('100000');
    expect(after.lines[0]?.unitPriceMinor).toBe('100000');
  });

  it('serialises two concurrent transitions on one order', async () => {
    // Both attempt the same transition. One wins; the other finds the order
    // already moved and is refused by the state machine rather than producing
    // a second history row.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('trans')),
    );

    const saga = <T>(fn: () => Promise<T>) =>
      asActor(
        {
          organizationId: org.buyer,
          authType: 'SERVICE',
          callerService: 'marketplace-service',
          roles: ['SERVICE'],
        },
        fn,
      );

    const transactionId = `TXN_${ulid()}`;
    const results = await Promise.allSettled([
      saga(() => wiring.orders.markFundsHeld(order.id, transactionId)),
      saga(() => wiring.orders.markFundsHeld(order.id, transactionId)),
    ]);

    // Both succeed, because a re-run of a completed activity is a no-op — but
    // only one history row exists.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

    const history = await runUnscoped('the suite counts the transitions written', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId: order.id, toStatus: 'FUNDS_HELD' },
      }),
    );
    expect(history).toHaveLength(1);
  });
});
