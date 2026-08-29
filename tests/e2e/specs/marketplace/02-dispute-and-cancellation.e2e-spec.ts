import { test, expect, errorCode, idempotencyKey, minor, type Actor } from '../../src/api';

/**
 * The two ways an order ends without a settlement.
 *
 * Both are financial paths and both are asserted against real balances: a
 * dispute must stop settlement completely, and a cancellation must actually
 * return the money before the order is reported cancelled.
 */

async function until(
  actor: Actor,
  orderId: string,
  statuses: readonly string[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never read';

  for (;;) {
    const response = await actor.get(`/v1/orders/${orderId}`);
    if (response.status === 200) {
      const order = response.body as Record<string, unknown>;
      last = String(order.status);
      if (statuses.includes(last)) return order;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Order ${orderId} never reached ${statuses.join(' or ')}; last status was ${last}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Polls the economic transaction until it reaches `status`.
 *
 * The saga mirrors a dispute onto the transaction from an activity, not inside
 * the HTTP call that raised it (ADR-040 § 5), so this is a real asynchronous
 * boundary rather than a flake to be slept away.
 */
async function untilTransaction(
  actor: Actor,
  transactionId: string,
  status: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never read';

  for (;;) {
    const response = await actor.get(`/v1/transactions/${transactionId}`);
    if (response.status === 200) {
      last = String((response.body as { status: string }).status);
      if (last === status) return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Transaction ${transactionId} never reached ${status}; last status was ${last}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function publishedOffer(tenantB: Actor, unitPriceMinor = '300000'): Promise<string> {
  const product = await tenantB.post('/v1/products', {
    body: {
      sku: `E2E-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
      name: 'شیلنگ هیدرولیک',
      category: 'PARTS',
      kind: 'GOOD',
      unit: 'عدد',
    },
  });
  const productId = (product.body as { id: string }).id;

  const offer = await tenantB.post('/v1/offers', {
    body: {
      productId,
      unitPriceMinor,
      currency: 'IRR',
      availableQuantity: 30,
      leadTimeDays: 2,
      minimumQuantity: 1,
      publish: true,
    },
  });
  return (offer.body as { id: string }).id;
}

test.describe.serial('a dispute stops settlement completely', () => {
  test('leaves the money held and refuses every route to settlement', async ({
    tenantA,
    tenantB,
  }) => {
    const offerId = await publishedOffer(tenantB);

    const placed = await tenantA.post('/v1/orders', {
      idempotencyKey: idempotencyKey('e2e-disputed'),
      body: { lines: [{ offerId, quantity: 1 }] },
    });
    expect(placed.status).toBe(201);
    const order = placed.body as { id: string };

    await until(tenantA, order.id, ['FUNDS_HELD']);

    const beforeDispute = await tenantA.get('/v1/wallets/me');
    const pendingBefore = minor(
      (beforeDispute.body as { pendingBalanceMinor: string }).pendingBalanceMinor,
    );

    await tenantB.post(`/v1/orders/${order.id}/confirm`, {
      idempotencyKey: idempotencyKey('e2e-d-confirm'),
    });
    await tenantB.post(`/v1/orders/${order.id}/fulfill`, {
      idempotencyKey: idempotencyKey('e2e-d-fulfill'),
      body: {},
    });

    const disputed = await tenantA.post(`/v1/orders/${order.id}/disputes`, {
      idempotencyKey: idempotencyKey('e2e-d-raise'),
      body: { reason: 'قطعه تحویل‌شده با مشخصات آگهی مطابقت ندارد' },
    });
    expect(disputed.status).toBe(200);
    expect((disputed.body as { status: string }).status).toBe('DISPUTED');

    // Confirming receipt is now refused: the order has no edge out of DISPUTED
    // that leads to settlement (ADR-038).
    const attempt = await tenantA.post(`/v1/orders/${order.id}/confirm-receipt`, {
      idempotencyKey: idempotencyKey('e2e-d-receipt'),
      body: {},
    });
    expect(attempt.status).toBe(422);
    expect(errorCode(attempt.body)).toBe('BUSINESS_RULE_VIOLATION');

    // The order stays disputed and the money stays exactly where it was.
    const after = await tenantA.get(`/v1/orders/${order.id}`);
    expect((after.body as { status: string }).status).toBe('DISPUTED');

    const wallet = await tenantA.get('/v1/wallets/me');
    expect(minor((wallet.body as { pendingBalanceMinor: string }).pendingBalanceMinor)).toBe(
      pendingBefore,
    );

    // economic-service knows too, so a direct settlement command is refused
    // there as well (ADR-040 § 5). Mirrored by a saga activity, so this waits.
    const orderView = after.body as { economicTransactionId: string };
    await untilTransaction(tenantA, orderView.economicTransactionId, 'DISPUTED');
  });

  test('refuses a party the right to resolve their own dispute', async ({ tenantA }) => {
    const list = await tenantA.get('/v1/orders?role=BUYER&status=DISPUTED&limit=1');
    const disputed = (list.body as { items: { id: string }[] }).items[0];
    expect(disputed).toBeDefined();

    const attempt = await tenantA.post(`/v1/orders/${disputed!.id}/disputes/resolve`, {
      idempotencyKey: idempotencyKey('e2e-self-resolve'),
      body: { outcome: 'SETTLE', resolution: 'من به نفع خودم تصمیم گرفتم' },
    });
    expect(attempt.status).toBe(403);
  });
});

test.describe.serial('cancellation returns the money before the order closes', () => {
  test('refunds the hold and only then reports the order cancelled', async ({
    tenantA,
    tenantB,
  }) => {
    const offerId = await publishedOffer(tenantB, '150000');

    const before = await tenantA.get('/v1/wallets/me');
    const opening = before.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    const availableBefore = minor(opening.availableBalanceMinor);
    const pendingBefore = minor(opening.pendingBalanceMinor);

    const placed = await tenantA.post('/v1/orders', {
      idempotencyKey: idempotencyKey('e2e-cancel'),
      body: { lines: [{ offerId, quantity: 2 }] },
    });
    expect(placed.status).toBe(201);
    const order = placed.body as { id: string };

    await until(tenantA, order.id, ['FUNDS_HELD']);

    const cancelled = await tenantA.post(`/v1/orders/${order.id}/cancel`, {
      idempotencyKey: idempotencyKey('e2e-cancel-cmd'),
      body: { reason: 'دیگر نیازی نیست' },
    });
    expect(cancelled.status).toBe(200);
    // CANCELLING, not CANCELLED: the refund has not happened yet, and saying it
    // had would report money returned that is still held.
    expect((cancelled.body as { status: string }).status).toBe('CANCELLING');

    const closed = await until(tenantA, order.id, ['CANCELLED']);
    expect(closed.cancellationReason).toBe('دیگر نیازی نیست');

    // The buyer is whole again: nothing held, nothing spent.
    const after = await tenantA.get('/v1/wallets/me');
    const closing = after.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    expect(minor(closing.pendingBalanceMinor)).toBe(pendingBefore);
    expect(minor(closing.availableBalanceMinor)).toBe(availableBefore);

    // And the obligation was refunded rather than left open.
    const transaction = await tenantA.get(
      `/v1/transactions/${String(closed.economicTransactionId)}`,
    );
    expect((transaction.body as { status: string }).status).toBe('REFUNDED');
  });

  test('returns what the cancelled order had reserved to the supplier', async ({
    tenantA,
    tenantB,
  }) => {
    const offerId = await publishedOffer(tenantB, '90000');

    const beforeOffer = await tenantB.get(`/v1/offers`);
    const available = (
      beforeOffer.body as { items: { id: string; availableQuantity: number }[] }
    ).items.find((o) => o.id === offerId)?.availableQuantity;
    expect(available).toBe(30);

    const placed = await tenantA.post('/v1/orders', {
      idempotencyKey: idempotencyKey('e2e-restore'),
      body: { lines: [{ offerId, quantity: 4 }] },
    });
    const order = placed.body as { id: string };
    await until(tenantA, order.id, ['FUNDS_HELD']);

    await tenantA.post(`/v1/orders/${order.id}/cancel`, {
      idempotencyKey: idempotencyKey('e2e-restore-cancel'),
      body: { reason: 'سفارش اشتباه ثبت شد' },
    });
    await until(tenantA, order.id, ['CANCELLED']);

    const afterOffer = await tenantB.get(`/v1/offers`);
    const restored = (
      afterOffer.body as { items: { id: string; availableQuantity: number }[] }
    ).items.find((o) => o.id === offerId)?.availableQuantity;
    expect(restored).toBe(30);
  });
});
