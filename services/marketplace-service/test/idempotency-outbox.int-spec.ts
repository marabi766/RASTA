import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  outboxFor,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import { hashRequestBody } from '../src/shared/idempotency';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Idempotency and the outbox, against a real database.
 *
 * The outbox guarantee is a pair, and only the pair is useful:
 *
 *   a change that commits **always** publishes its event
 *   a change that rolls back **never** publishes its event
 *
 * The second half is what this file exists for. An outbox that satisfies only
 * the first looks correct until something fails, and in a marketplace the
 * consequence is concrete: a phantom `ORDER_CREATED` tells every consumer an
 * order exists that the buyer never placed.
 */
describe('idempotency and outbox (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let store: PrismaOutboxStore;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    store = new PrismaOutboxStore(prisma);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-BUYER' }, fn);

  // -------------------------------------------------------------------------

  describe('Idempotency-Key', () => {
    it('returns the original order on a retry with the same key and body', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 10 });
      const idempotencyKey = key('same');
      const body = { lines: [{ offerId, quantity: 2 }] };

      const first = await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );
      const replay = await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );

      expect(replay.id).toBe(first.id);

      // And exactly one order exists — the retry did not place a second.
      const orders = await runUnscoped('the suite counts the orders the retry produced', () =>
        prisma.client.order.findMany({ where: { idempotencyKey } }),
      );
      expect(orders).toHaveLength(1);

      // And the availability was consumed once, not twice.
      const offer = await runUnscoped('the suite verifies availability moved once', () =>
        prisma.client.offer.findUnique({ where: { id: offerId } }),
      );
      expect(offer?.availableQuantity).toBe(8);
    });

    it('refuses the same key with a different body', async () => {
      const first = await publishOffer(wiring, org.supplier);
      const second = await publishOffer(wiring, org.supplier);
      const idempotencyKey = key('reused');

      await asBuyer(() =>
        wiring.idempotency.run(
          'POST /v1/orders',
          idempotencyKey,
          { lines: [{ offerId: first.offerId, quantity: 1 }] },
          201,
          () =>
            wiring.orders.place(
              { lines: [{ offerId: first.offerId, quantity: 1 }] },
              idempotencyKey,
            ),
        ),
      );

      await expect(
        asBuyer(() =>
          wiring.idempotency.run(
            'POST /v1/orders',
            idempotencyKey,
            { lines: [{ offerId: second.offerId, quantity: 1 }] },
            201,
            () =>
              wiring.orders.place(
                { lines: [{ offerId: second.offerId, quantity: 1 }] },
                idempotencyKey,
              ),
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }));
    });

    it('scopes a key to its organization, so two tenants cannot collide', async () => {
      const mine = await publishOffer(wiring, org.supplier);
      const theirs = await publishOffer(wiring, org.supplier);
      const shared = key('shared');

      const first = await asBuyer(() =>
        wiring.idempotency.run(
          'POST /v1/orders',
          shared,
          { lines: [{ offerId: mine.offerId, quantity: 1 }] },
          201,
          () => wiring.orders.place({ lines: [{ offerId: mine.offerId, quantity: 1 }] }, shared),
        ),
      );

      // The same key, a different tenant, a different body: not a conflict,
      // because the record is keyed by (organization, endpoint, key).
      const second = await asActor(
        { organizationId: org.other, roles: ['PROCUREMENT_USER'], userId: 'USR-OTHER' },
        () =>
          wiring.idempotency.run(
            'POST /v1/orders',
            shared,
            { lines: [{ offerId: theirs.offerId, quantity: 1 }] },
            201,
            () =>
              wiring.orders.place({ lines: [{ offerId: theirs.offerId, quantity: 1 }] }, shared),
          ),
      );

      expect(second.id).not.toBe(first.id);
      expect(second.buyerOrganizationId).toBe(org.other);
    });

    it('lets a corrected retry through after the first attempt failed', async () => {
      // A failed attempt must not wedge the key: an order refused for
      // insufficient availability should be retryable once the supplier
      // restocks, with the same key.
      const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 1 });
      const idempotencyKey = key('recover');
      const body = { lines: [{ offerId, quantity: 5 }] };

      await expect(
        asBuyer(() =>
          wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
            wiring.orders.place(body, idempotencyKey),
          ),
        ),
      ).rejects.toThrow();

      await asActor({ organizationId: org.supplier, roles: ['SUPPLIER'] }, () =>
        wiring.catalogue.updateOffer(offerId, { availableQuantity: 20 }),
      );

      const order = await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );
      expect(order.totalAmountMinor).toBe('1250000');
    });

    it('hashes two orderings of the same body identically', async () => {
      // The same request serialised by two different clients is a retry, not a
      // key reused with a different body (docs/06 § 6.8).
      expect(hashRequestBody({ a: 1, b: 2 })).toBe(hashRequestBody({ b: 2, a: 1 }));
      expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
    });

    it('tells a client its own request is still running, rather than replaying nothing', async () => {
      // The genuine double-submit: the same key arrives while the first call
      // is still open. There is no response to replay yet, and proceeding
      // would place the order twice. The caller is told to retry, and the
      // status is a CONFLICT rather than a key-reuse — the key was not reused,
      // the client was simply early.
      const { offerId } = await publishOffer(wiring, org.supplier);
      const idempotencyKey = key('inflight');
      const body = { lines: [{ offerId, quantity: 1 }] };

      // Claim without ever completing, which is exactly the state a request
      // that is still in flight leaves behind.
      await asBuyer(() => wiring.idempotency.claim('POST /v1/orders', idempotencyKey, body));

      await expect(
        asBuyer(() => wiring.idempotency.claim('POST /v1/orders', idempotencyKey, body)),
      ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    });

    it('treats an expired key as a fresh one rather than replaying stale work', async () => {
      // The TTL is what stops the table growing without bound. Once a key has
      // expired, the same key is a new request: replaying a week-old response
      // to it would answer a question nobody asked.
      const { offerId } = await publishOffer(wiring, org.supplier);
      const idempotencyKey = key('expired');
      const body = { lines: [{ offerId, quantity: 1 }] };

      const first = await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );

      // Both timestamps move: `ck_idempotency_expiry` requires an expiry after
      // the row was created, so backdating only the expiry would be refused —
      // correctly, since such a row could never have been written.
      await runUnscoped('the suite ages the key past its TTL', () =>
        prisma.client.idempotencyKey.updateMany({
          where: { key: idempotencyKey },
          data: {
            createdAt: new Date(Date.now() - 7_200_000),
            expiresAt: new Date(Date.now() - 60_000),
          },
        }),
      );

      const second = await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );

      // A genuinely new order, not the old one handed back.
      expect(second.id).not.toBe(first.id);
    });

    it('replays with the status the first call returned', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier);
      const idempotencyKey = key('status');
      const body = { lines: [{ offerId, quantity: 1 }] };

      await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );

      const replay = await asBuyer(() =>
        wiring.idempotency.claim('POST /v1/orders', idempotencyKey, body),
      );
      expect(replay).toMatchObject({ kind: 'REPLAY', status: 201 });
    });

    it('replays a recorded response that carried no status as a 200', async () => {
      // A row written before the status column was populated, or by a path
      // that recorded no status. Replaying `undefined` would hand the client a
      // response with no status line at all; 200 is the honest default for a
      // call that is known to have succeeded.
      const { offerId } = await publishOffer(wiring, org.supplier);
      const idempotencyKey = key('nostatus');
      const body = { lines: [{ offerId, quantity: 1 }] };

      await asBuyer(() =>
        wiring.idempotency.run('POST /v1/orders', idempotencyKey, body, 201, () =>
          wiring.orders.place(body, idempotencyKey),
        ),
      );

      await runUnscoped('the suite clears the recorded status', () =>
        prisma.client.idempotencyKey.updateMany({
          where: { key: idempotencyKey },
          data: { responseStatus: null },
        }),
      );

      const replay = await asBuyer(() =>
        wiring.idempotency.claim('POST /v1/orders', idempotencyKey, body),
      );
      expect(replay).toMatchObject({ kind: 'REPLAY', status: 200 });
    });
  });

  describe('a committed change always publishes', () => {
    it('writes the order and its event in one transaction', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier);
      const order = await asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('outbox')),
      );

      const rows = await outboxFor(prisma, org.buyer);
      const created = rows.find(
        (row) =>
          row.eventName === 'ORDER_CREATED' &&
          (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
      );

      expect(created).toBeDefined();
      expect(created?.topic).toBe('rasta.marketplace.v1');
      expect(created?.publishedAt).toBeNull();
      expect(created?.correlationId).toBeTruthy();
    });

    it('carries the envelope headers a consumer filters on', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier);
      const order = await asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('headers')),
      );

      const rows = await outboxFor(prisma, org.buyer);
      const created = rows.find(
        (row) => (row.payload as { payload?: { orderId?: string } })?.payload?.orderId === order.id,
      );

      const headers = created?.headers as Record<string, string>;
      expect(headers['x-event-name']).toBe('ORDER_CREATED');
      expect(headers['x-tenant-id']).toBe(org.buyer);
      expect(headers['x-correlation-id']).toBeTruthy();
    });
  });

  describe('a rolled-back change never publishes', () => {
    it('leaves no outbox row when the order is refused', async () => {
      const { offerId } = await publishOffer(wiring, org.supplier, { availableQuantity: 1 });
      const before = (await outboxFor(prisma, org.buyer)).length;

      await expect(
        asBuyer(() => wiring.orders.place({ lines: [{ offerId, quantity: 99 }] }, key('rollback'))),
      ).rejects.toThrow();

      const after = await outboxFor(prisma, org.buyer);
      expect(after).toHaveLength(before);

      // And the availability was not consumed by the attempt.
      const offer = await runUnscoped('the suite verifies the refused order took nothing', () =>
        prisma.client.offer.findUnique({ where: { id: offerId } }),
      );
      expect(offer?.availableQuantity).toBe(1);
    });

    it('refuses to enqueue a payload that does not match its contract', async () => {
      // Publish-time validation keeps a malformed event out of the log
      // entirely, rather than leaving it to be discovered in a dead-letter
      // topic somebody else owns (docs/07 § 7.8).
      await expect(
        asBuyer(() =>
          prisma.transaction((tx) =>
            wiring.events.enqueue(tx, {
              eventName: 'ORDER_CREATED',
              aggregateId: 'ORD_BROKEN',
              organizationId: org.buyer,
              // A JSON number where a minor-unit string belongs.
              payload: { orderId: 'ORD_BROKEN', totalAmountMinor: 500000 },
            }),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe('the relay claim', () => {
    it('claims only unpublished rows and records a failure without losing one', async () => {
      const id = `OBX_ITEST_${ulid()}`;
      const orderId = `ORD_ITEST_${ulid()}`;

      await runUnscoped('the suite writes a row to exercise the relay', () =>
        prisma.client.outboxMessage.create({
          data: {
            id,
            aggregateType: 'Order',
            aggregateId: orderId,
            eventName: 'ORDER_CREATED',
            topic: 'rasta.marketplace.v1',
            partitionKey: orderId,
            payload: {},
            headers: {},
            organizationId: org.buyer,
            correlationId: 'itest',
          },
        }),
      );

      // Each mutation is fenced on the claim token, and each failure releases
      // the claim — so the row is re-claimed for the second failure, exactly as
      // the relay does on its next tick (ADR-050). A zero lease keeps this
      // suite from parking rows for any other.
      const claimOwned = () =>
        store.claimPending({ limit: 500, owner: 'mkt-int-spec', leaseSeconds: 0 });
      const noBackoff = { baseSeconds: 0, maxSeconds: 0 };

      const first = await claimOwned();
      expect(await store.markFailed(id, first.token!, 'broker unreachable', noBackoff)).toBe(1);
      const second = await claimOwned();
      expect(await store.markFailed(id, second.token!, 'broker unreachable again', noBackoff)).toBe(
        1,
      );

      const claimed = (await claimOwned()).rows.find((row) => row.id === id);

      expect(claimed).toBeDefined();
      expect(claimed?.attempts).toBe(2);
      // ADR-036: the key is a stored column, so the second attempt and the
      // tenth carry what the first did. A retry that re-derived it could move
      // the event to another partition on the attempt nobody watches.
      expect(claimed?.partitionKey).toBe(orderId);
    });
  });
});
