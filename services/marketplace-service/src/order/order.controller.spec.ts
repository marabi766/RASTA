import { randomBytes } from 'node:crypto';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { OrderController } from './order.controller';
import { IdempotencyStore, hashRequestBody, targeted } from '../shared/idempotency';
import type { OrderService } from './order.service';
import type { OrderSagaClient } from '../temporal/saga.client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';

/**
 * A replayed command must never reach an order it did not run on.
 *
 * The defect this file pins: every targeted order command stored its
 * `Idempotency-Key` under the route **template** and hashed the body alone,
 * then signalled the saga for whatever id the URL named — whether or not the
 * command had run. A buyer who confirmed receipt on its own order X with key K
 * could send K and the same body to `/orders/Y/confirm-receipt`. The store saw
 * a replay, returned X's response and ran nothing against Y — no party check,
 * no transition check — and the controller still told Y's saga
 * `receiptConfirmed`. Y could be any tenant's order. With `cancel`, the saga's
 * compensation then refunded Y's money while Y's order row never moved.
 *
 * What is real here: the controller, and the whole of {@link IdempotencyStore}
 * — the claim, the canonical hash, the replay and conflict decisions. What is
 * stubbed: the table under the store (an in-memory map keyed exactly like the
 * real unique index), the domain service, and the saga client, whose calls are
 * what these tests assert on.
 */

const BUYER_ORG = 'ORG-UNIT-BUYER';
const VICTIM_ORG = 'ORG-UNIT-VICTIM';
const OWN_ORDER = 'ORD_OWN';
const VICTIM_ORDER = 'ORD_VICTIM';

/** The idempotency table, keyed like `@@unique([organizationId, endpoint, key])`. */
function inMemoryKeyTable() {
  interface Row {
    key: string;
    organizationId: string;
    endpoint: string;
    requestHash: string;
    state: 'IN_PROGRESS' | 'COMPLETED';
    expiresAt: Date;
    responseStatus?: number;
    responseBody?: unknown;
  }
  const rows = new Map<string, Row>();
  const id = (organizationId: string, endpoint: string, key: string) =>
    `${organizationId}|${endpoint}|${key}`;

  const idempotencyKey = {
    create: async ({ data }: { data: Row }) => {
      const k = id(data.organizationId, data.endpoint, data.key);
      if (rows.has(k)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      rows.set(k, { ...data });
      return data;
    },
    findUnique: async ({
      where,
    }: {
      where: {
        organizationId_endpoint_key: { organizationId: string; endpoint: string; key: string };
      };
    }) => {
      const w = where.organizationId_endpoint_key;
      return rows.get(id(w.organizationId, w.endpoint, w.key)) ?? null;
    },
    delete: async ({
      where,
    }: {
      where: {
        organizationId_endpoint_key: { organizationId: string; endpoint: string; key: string };
      };
    }) => {
      const w = where.organizationId_endpoint_key;
      rows.delete(id(w.organizationId, w.endpoint, w.key));
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { organizationId: string; endpoint: string; key: string; state: string };
      data: Partial<Row>;
    }) => {
      const row = rows.get(id(where.organizationId, where.endpoint, where.key));
      if (row && row.state === where.state) Object.assign(row, data);
      return { count: row ? 1 : 0 };
    },
    deleteMany: async ({
      where,
    }: {
      where: { organizationId: string; endpoint: string; key: string; state: string };
    }) => {
      const k = id(where.organizationId, where.endpoint, where.key);
      const row = rows.get(k);
      if (row && row.state === where.state) rows.delete(k);
      return { count: row ? 1 : 0 };
    },
  };

  return { prisma: { client: { idempotencyKey } } as unknown as PrismaService, rows };
}

/**
 * The domain service, reduced to the one fact these tests need: which order
 * each command actually ran against. Every command answers with the order it
 * was given, as the real one does.
 */
function recordingOrders() {
  const ran: Array<{ command: string; id: string }> = [];
  const answer = (command: string) =>
    jest.fn(async (id: string) => {
      ran.push({ command, id });
      return { id, status: `AFTER_${command}` };
    });
  const orders = {
    confirm: answer('confirm'),
    fulfill: answer('fulfill'),
    confirmReceipt: answer('confirmReceipt'),
    raiseDispute: answer('raiseDispute'),
    resolveDispute: answer('resolveDispute'),
    cancel: answer('cancel'),
    submitReview: answer('submitReview'),
  };
  return { orders, ran };
}

function setup() {
  const table = inMemoryKeyTable();
  const store = new IdempotencyStore(table.prisma, {
    MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24,
  } as MarketplaceEnv);
  const { orders, ran } = recordingOrders();
  const signal = jest.fn(async (..._args: unknown[]) => undefined);
  const saga = { signal, start: jest.fn(async () => undefined) } as unknown as OrderSagaClient;
  return {
    controller: new OrderController(orders as unknown as OrderService, saga, store),
    orders,
    ran,
    signal,
    table,
  };
}

/** Runs `fn` as a caller acting for `organizationId`, as the guard would set it. */
function as<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  const context = {
    requestId: `req-${organizationId}`,
    correlationId: `corr-${organizationId}`,
    organizationId,
    organizationIds: [organizationId],
    authType: 'USER',
    roles: ['PROCUREMENT_USER'],
    userId: `USR-${organizationId}`,
    startedAt: 0,
  } as unknown as RequestContext;
  return runWithContext(context, fn);
}

/** Generated, not written down: a literal assigned to `KEY` reads as a secret to a scanner. */
const KEY = `replay-${randomBytes(8).toString('hex')}`;

/**
 * Each targeted command, with the body a caller sends and the signal its saga
 * receives. `confirm` has no body — its identity was always `{ id }`.
 */
const COMMANDS = [
  {
    name: 'confirm',
    call: (c: OrderController, id: string) => c.confirm(id, KEY),
    signal: 'orderConfirmed',
  },
  {
    name: 'fulfill',
    call: (c: OrderController, id: string) =>
      c.fulfill(id, { trackingReference: 'WAYBILL-1' }, KEY),
    signal: 'orderFulfilled',
  },
  {
    name: 'confirm-receipt',
    call: (c: OrderController, id: string) => c.confirmReceipt(id, {}, KEY),
    signal: 'receiptConfirmed',
  },
  {
    name: 'dispute',
    call: (c: OrderController, id: string) =>
      c.dispute(id, { reason: 'The delivered parts do not match the order.' }, KEY),
    signal: 'orderDisputed',
  },
  {
    name: 'resolve',
    call: (c: OrderController, id: string) =>
      c.resolveDispute(
        id,
        {
          outcome: 'REFUND',
          resolution: 'The supplier agreed to take the parts back.',
          responsibility: 'SUPPLIER',
        },
        KEY,
      ),
    signal: 'disputeResolved',
  },
  {
    name: 'cancel',
    call: (c: OrderController, id: string) =>
      c.cancel(id, { reason: 'Ordered against the wrong asset by mistake.' }, KEY),
    signal: 'orderCancelled',
  },
] as const;

describe('OrderController — a replay never reaches an order it did not run on', () => {
  describe.each(COMMANDS)('$name', ({ call, signal: signalName }) => {
    it('refuses the same key on another order with 409 and signals nothing for it', async () => {
      const { controller, ran, signal } = setup();

      await as(BUYER_ORG, () => call(controller, OWN_ORDER));
      signal.mockClear();

      // The attack: same caller, same key, same body — a different order,
      // here another tenant's.
      await expect(as(BUYER_ORG, () => call(controller, VICTIM_ORDER))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });

      expect(signal).not.toHaveBeenCalled();
      expect(ran.map((r) => r.id)).not.toContain(VICTIM_ORDER);
    });

    it('replays the same order idempotently: one run, one signal, the stored response', async () => {
      const { controller, ran, signal } = setup();

      const first = await as(BUYER_ORG, () => call(controller, OWN_ORDER));
      const replay = await as(BUYER_ORG, () => call(controller, OWN_ORDER));

      expect(replay).toEqual(first);
      expect(ran).toHaveLength(1);
      // Signalled once, by the request that ran — not again by the replay,
      // which approved nothing.
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal.mock.calls[0]?.slice(0, 2)).toEqual([OWN_ORDER, signalName]);
    });

    it('signals nothing when the command itself is refused', async () => {
      const { controller, orders, signal } = setup();
      const refused = Object.assign(new Error('not a party to this order'), { code: 'NOT_FOUND' });
      // Every command refuses, as the party check does for a stranger.
      for (const fn of Object.values(orders)) fn.mockRejectedValueOnce(refused);

      await expect(as(BUYER_ORG, () => call(controller, VICTIM_ORDER))).rejects.toBe(refused);
      expect(signal).not.toHaveBeenCalled();
    });
  });

  it('keys another tenant apart even when it reuses the same key on its own order', async () => {
    // Keys are per organization. The victim's own, unrelated use of the same
    // key string runs and signals its own order, and nothing the first caller
    // did is replayed to it.
    const { controller, ran, signal } = setup();

    await as(BUYER_ORG, () =>
      controller.cancel(OWN_ORDER, { reason: 'Ordered by mistake, sorry.' }, KEY),
    );
    await as(VICTIM_ORG, () =>
      controller.cancel(VICTIM_ORDER, { reason: 'Ordered by mistake, sorry.' }, KEY),
    );

    expect(ran).toEqual([
      { command: 'cancel', id: OWN_ORDER },
      { command: 'cancel', id: VICTIM_ORDER },
    ]);
    expect(signal.mock.calls.map(([id]) => id)).toEqual([OWN_ORDER, VICTIM_ORDER]);
  });

  it('refuses a review reusing a key on another order rather than replaying the first', async () => {
    const { controller, ran } = setup();
    const review = { rating: 5, comment: 'Delivered on time and as described.' };

    await as(BUYER_ORG, () => controller.review(OWN_ORDER, review, KEY));
    await expect(
      as(BUYER_ORG, () => controller.review(VICTIM_ORDER, review, KEY)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(ran).toEqual([{ command: 'submitReview', id: OWN_ORDER }]);
  });
});

describe('targeted — the request identity of a command on one order', () => {
  const reason = { reason: 'Ordered against the wrong asset by mistake.' };

  it('tells two orders apart even when the body is identical', () => {
    expect(hashRequestBody(targeted(OWN_ORDER, reason))).not.toBe(
      hashRequestBody(targeted(VICTIM_ORDER, reason)),
    );
  });

  it('is still a retry for the same order and the same body', () => {
    expect(hashRequestBody(targeted(OWN_ORDER, reason))).toBe(
      hashRequestBody(targeted(OWN_ORDER, { ...reason })),
    );
  });

  it('with no body, hashes exactly what confirm always stored', () => {
    // So confirm keys recorded before this change still match after it.
    expect(hashRequestBody(targeted(OWN_ORDER))).toBe(hashRequestBody({ id: OWN_ORDER }));
  });
});
