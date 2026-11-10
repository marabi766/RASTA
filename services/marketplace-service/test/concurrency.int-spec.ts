import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  sagaStep,
  tenants,
  waitFor,
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
    await prisma.stop();
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
        wiring.orders.place(
          { lines: [{ offerId, offerVersion: 1, quantity: 3 }] },
          key(`race-${i}`),
        ),
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
        wiring.orders.place(
          { lines: [{ offerId: first.offerId, offerVersion: 1, quantity: 2 }] },
          key('par-a'),
        ),
      ),
      asBuyer(() =>
        wiring.orders.place(
          { lines: [{ offerId: second.offerId, offerVersion: 1, quantity: 2 }] },
          key('par-b'),
        ),
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
              { offerId: first.offerId, offerVersion: 1, quantity: 1 },
              { offerId: second.offerId, offerVersion: 1, quantity: 1 },
            ],
          },
          key('dl-a'),
        ),
      ),
      asBuyer(() =>
        wiring.orders.place(
          {
            lines: [
              { offerId: second.offerId, offerVersion: 1, quantity: 1 },
              { offerId: first.offerId, offerVersion: 1, quantity: 1 },
            ],
          },
          key('dl-b'),
        ),
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.id)).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // D-156: an order is placed only at the offer version the buyer read.
  // -------------------------------------------------------------------------

  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-SUP' }, fn);

  /** What an order could have written: the offer's availability, its lines, the buyer's events. */
  async function footprint(offerId: string) {
    return runUnscoped('the suite reads what a refused order must not have written', async () => {
      const offer = await prisma.client.offer.findUniqueOrThrow({ where: { id: offerId } });
      const lines = await prisma.client.orderLine.count({ where: { offerId } });
      const events = await prisma.client.outboxMessage.count({
        where: { organizationId: org.buyer },
      });
      return { available: offer.availableQuantity, version: offer.version, lines, events };
    });
  }

  /**
   * Resolves once another backend of this database is waiting on a row lock —
   * the barrier that makes the interleaving below real rather than hoped for.
   */
  function lockWaiter(): Promise<true> {
    return waitFor(
      'a transaction waiting on the offer row lock',
      async () => {
        const [row] = await prisma.client.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%FOR UPDATE%'`;
        return (row?.waiting ?? 0n) > 0n ? (true as const) : null;
      },
      10_000,
      20,
    );
  }

  /** Every committed line's (offer, version, price, currency) is a published history row. */
  async function unprovenLines(offerId: string): Promise<number> {
    const [row] = await runUnscoped(
      'the suite joins lines to the price history',
      () =>
        prisma.client.$queryRaw<{ unproven: bigint }[]>`
        SELECT count(*) AS unproven FROM order_line l
         WHERE l.offer_id = ${offerId}
           AND NOT EXISTS (
             SELECT 1 FROM offer_price_history h
              WHERE h.offer_id = l.offer_id AND h.version = l.offer_version
                AND h.unit_price_minor = l.unit_price_minor AND h.currency = l.currency)`,
    );
    return Number(row?.unproven ?? -1n);
  }

  it('refuses an order at the version the buyer read once a reprice has committed, and writes nothing', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, {
      unitPriceMinor: '100000',
      availableQuantity: 5,
    });
    // The buyer reads v1, then the supplier reprices before the order arrives.
    await asSupplier(() => wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '175000' }));
    const before = await footprint(offerId);
    expect(before.version).toBe(2);

    await expect(
      asBuyer(() =>
        wiring.orders.place(
          { lines: [{ offerId, offerVersion: 1, quantity: 2 }] },
          key('stale-read'),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'OPTIMISTIC_LOCK_FAILED',
      details: [{ path: 'lines[0].offerVersion', code: 'OFFER_VERSION_CHANGED' }],
    });
    // No order, no availability consumed, no event.
    expect(await footprint(offerId)).toEqual(before);

    // The version the offer is at now is accepted, at its price.
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, offerVersion: 2, quantity: 2 }] }, key('fresh')),
    );
    expect(order.lines[0]).toMatchObject({ offerVersion: 2, unitPriceMinor: '175000' });
    expect(order.totalAmountMinor).toBe('350000');
  });

  it('refuses an order that waited on a reprice holding the offer lock (reprice first)', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });
    const before = await footprint(offerId);

    let placing: Promise<unknown> | undefined;
    // The reprice's last statement runs under its offer lock: the order starts
    // there, blocks on the same row, and is let through only by the commit.
    await asSupplier(() =>
      wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '120000' }, async () => {
        placing = asBuyer(() =>
          wiring.orders.place(
            { lines: [{ offerId, offerVersion: 1, quantity: 1 }] },
            key('behind-reprice'),
          ),
        ).catch((error: unknown) => error);
        await lockWaiter();
      }),
    );

    expect(await placing).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    expect(await footprint(offerId)).toEqual({ ...before, version: 2 });
  });

  it('commits an order holding the offer lock at its price; the waiting reprice then makes v+1 (order first)', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });

    let repricing: Promise<unknown> | undefined;
    const order = await asBuyer(() =>
      wiring.orders.place(
        { lines: [{ offerId, offerVersion: 1, quantity: 1 }] },
        key('ahead-of-reprice'),
        async () => {
          // The order's last statement, under its offer lock: the reprice
          // blocks on `updateOffer`'s own FOR UPDATE of the same row.
          repricing = asSupplier(() =>
            wiring.catalogue.updateOffer(offerId, { unitPriceMinor: '130000' }),
          );
          await lockWaiter();
        },
      ),
    );
    expect(await repricing).toMatchObject({ version: 2, unitPriceMinor: '130000' });

    // The line keeps v1 and its price; the offer moved on to v2 after it.
    const after = await asBuyer(() => wiring.orders.get(order.id));
    expect(after.lines[0]).toMatchObject({ offerVersion: 1, unitPriceMinor: '100000' });
    expect(after.totalAmountMinor).toBe('100000');
    expect((await footprint(offerId)).version).toBe(2);
    expect(await unprovenLines(offerId)).toBe(0);
  });

  it('two buyers and a reprice racing, repeatedly: every committed line is a published (version, price)', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier, {
      unitPriceMinor: '100000',
      availableQuantity: 1_000,
    });
    let committed = 0;

    for (let round = 0; round < 12; round += 1) {
      const read = (await footprint(offerId)).version;
      const order = (buyer: string, label: string) =>
        asBuyer(
          () =>
            wiring.orders.place(
              { lines: [{ offerId, offerVersion: read, quantity: 1 }] },
              key(`race-${label}-${round}`),
            ),
          buyer,
        ).then(
          (placed) => ({ ok: true as const, version: placed.lines[0]?.offerVersion }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      const [a, b] = await Promise.all([
        order(org.buyer, 'a'),
        order(org.other, 'b'),
        asSupplier(() =>
          wiring.catalogue.updateOffer(offerId, { unitPriceMinor: String(100_000 + round + 1) }),
        ),
      ]);
      for (const result of [a, b]) {
        if (result.ok) {
          committed += 1;
          // Only ever the version the buyer read.
          expect(result.version).toBe(read);
        } else {
          expect(result.error).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
        }
      }
    }

    expect(committed).toBeGreaterThan(0);
    expect(await unprovenLines(offerId)).toBe(0);
  });

  it('leaves an order already placed at the price it agreed to', async () => {
    // A supplier cannot reprice work already sold.
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '100000' });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('frozen')),
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
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('trans')),
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
    // Two attempts of one scheduled activity — Temporal starts the second when
    // the first overruns its timeout — so one step key (D-053).
    const step = sagaStep();
    const results = await Promise.allSettled([
      saga(() => wiring.orders.markFundsHeld(order.id, transactionId, step)),
      saga(() => wiring.orders.markFundsHeld(order.id, transactionId, step)),
    ]);

    // Both succeed, because a re-run of a completed activity is a no-op — but
    // only one history row exists, and both answer what the first did.
    expect(results).toEqual([
      { status: 'fulfilled', value: 'FUNDS_HELD' },
      { status: 'fulfilled', value: 'FUNDS_HELD' },
    ]);

    const history = await runUnscoped('the suite counts the transitions written', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId: order.id, toStatus: 'FUNDS_HELD' },
      }),
    );
    expect(history).toHaveLength(1);
  });
});
