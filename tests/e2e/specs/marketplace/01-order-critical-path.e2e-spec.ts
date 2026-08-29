import { test, expect, errorCode, idempotencyKey, minor, type Actor } from '../../src/api';

/**
 * The marketplace critical path, end to end (`docs/17` § Marketplace).
 *
 * Through the real thing: Keycloak tokens, api-gateway, marketplace-service,
 * economic-service, PostgreSQL, Kafka and Temporal. Nothing here is stubbed —
 * the money that moves is recorded in the ledger by economic-service, and the
 * order advances because a Temporal worker drove it there.
 *
 * `tenantA` is the buyer and `tenantB` the supplier. Both are seeded
 * organization administrators, which `docs/09` § 9.3 defines as "everything in
 * their own organization" — so B sells and A buys, and each is refused the
 * other's half.
 *
 * ## Why the saga is given time
 *
 * The order advances through a Temporal activity, not through the HTTP call
 * that triggered it. `until()` polls the order rather than sleeping a fixed
 * interval, so the suite is neither flaky nor slower than it needs to be.
 */

/** Polls until the order reaches one of `statuses`, or fails saying what it saw. */
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
        `Order ${orderId} never reached ${statuses.join(' or ')}; last status was ${last}. ` +
          'If this is the only failure, the Temporal worker is probably not running.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.describe.serial('the marketplace critical path', () => {
  let productId: string;
  let offerId: string;

  test('a supplier publishes an offer and a buyer can find it', async ({ tenantA, tenantB }) => {
    const sku = `E2E-SKU-${Date.now()}`;

    const product = await tenantB.post('/v1/products', {
      body: {
        sku,
        name: 'فیلتر روغن بیل مکانیکی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      },
    });
    expect(product.status).toBe(201);
    productId = (product.body as { id: string }).id;

    const offer = await tenantB.post('/v1/offers', {
      body: {
        productId,
        unitPriceMinor: '450000',
        currency: 'IRR',
        availableQuantity: 25,
        leadTimeDays: 4,
        minimumQuantity: 1,
        publish: true,
      },
    });
    expect(offer.status).toBe(201);
    offerId = (offer.body as { id: string }).id;

    // ADR-041: the qualification check did not run, and the API says so rather
    // than reporting `false`, which would claim the supplier had failed one.
    expect((offer.body as { supplierQualification: string }).supplierQualification).toBe(
      'UNAVAILABLE',
    );

    // The buyer, in a different organization, can see it. That crossing is the
    // marketplace: a catalogue you can only see your own listings in is not one.
    const search = await tenantA.get('/v1/products?q=فیلتر&sort=PRICE_ASC');
    expect(search.status).toBe(200);
    const found = (search.body as { items: { id: string }[] }).items.find(
      (item) => item.id === productId,
    );
    expect(found).toBeDefined();
  });

  test('rejects a sort the platform cannot honestly perform', async ({ tenantA }) => {
    // `RATING` needs supplier-service, which does not exist. Accepting it and
    // ordering by price instead would tell the client its ordering was applied
    // (ADR-042 § 2).
    const response = await tenantA.get('/v1/products?sort=RATING');
    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('VALIDATION_FAILED');
  });

  test('refuses an order that tries to name its own price', async ({ tenantA }) => {
    // Refused, not ignored. Ignoring it leaves a client believing it sets the
    // price (ADR-037 § 5).
    const response = await tenantA.post('/v1/orders', {
      idempotencyKey: idempotencyKey('e2e-price'),
      body: { lines: [{ offerId, quantity: 1, unitPriceMinor: '1' }] },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('VALIDATION_FAILED');
  });

  test('refuses an order with no Idempotency-Key', async ({ tenantA }) => {
    const response = await tenantA.post('/v1/orders', {
      body: { lines: [{ offerId, quantity: 1 }] },
    });
    expect(response.status).toBe(400);
  });

  test('carries an order from placement to a settled, balanced completion', async ({
    tenantA,
    tenantB,
  }) => {
    const walletBefore = await tenantA.get('/v1/wallets/me');
    expect(walletBefore.status).toBe(200);
    const opening = walletBefore.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    const availableBefore = minor(opening.availableBalanceMinor);
    const pendingBefore = minor(opening.pendingBalanceMinor);

    // ---- place -----------------------------------------------------------
    const orderKey = idempotencyKey('e2e-order');
    const placed = await tenantA.post('/v1/orders', {
      idempotencyKey: orderKey,
      body: { lines: [{ offerId, quantity: 2 }] },
    });

    expect(placed.status).toBe(201);
    const order = placed.body as { id: string; totalAmountMinor: string; status: string };
    // Priced from the server-side offer: two at 450 000.
    expect(minor(order.totalAmountMinor)).toBe(900_000n);

    // ---- the saga holds the funds ----------------------------------------
    const held = await until(tenantA, order.id, ['FUNDS_HELD']);
    expect(held.economicTransactionId).toBeTruthy();

    // The money is really reserved, in economic-service's ledger.
    const duringHold = await tenantA.get('/v1/wallets/me');
    const holding = duringHold.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    expect(minor(holding.availableBalanceMinor)).toBe(availableBefore - 900_000n);
    expect(minor(holding.pendingBalanceMinor)).toBe(pendingBefore + 900_000n);

    // ---- a replay does not place a second order ---------------------------
    const replay = await tenantA.post('/v1/orders', {
      idempotencyKey: orderKey,
      body: { lines: [{ offerId, quantity: 2 }] },
    });
    expect(replay.status).toBe(201);
    expect((replay.body as { id: string }).id).toBe(order.id);

    const afterReplay = await tenantA.get('/v1/wallets/me');
    expect(minor((afterReplay.body as { pendingBalanceMinor: string }).pendingBalanceMinor)).toBe(
      pendingBefore + 900_000n,
    );

    // ---- the supplier accepts and delivers --------------------------------
    const confirmed = await tenantB.post(`/v1/orders/${order.id}/confirm`, {
      idempotencyKey: idempotencyKey('e2e-confirm'),
    });
    expect(confirmed.status).toBe(200);

    const fulfilled = await tenantB.post(`/v1/orders/${order.id}/fulfill`, {
      idempotencyKey: idempotencyKey('e2e-fulfill'),
      body: { trackingReference: 'E2E-WB-001' },
    });
    expect(fulfilled.status).toBe(200);
    expect((fulfilled.body as { status: string }).status).toBe('AWAITING_RECEIPT_CONFIRMATION');

    // ---- settlement is refused before the buyer confirms ------------------
    //
    // Asserted from the supplier's side: they cannot confirm their own
    // delivery, which is what would otherwise release the money.
    const supplierAttempt = await tenantB.post(`/v1/orders/${order.id}/confirm-receipt`, {
      idempotencyKey: idempotencyKey('e2e-supplier-confirm'),
      body: {},
    });
    expect(supplierAttempt.status).toBe(403);

    const stillWaiting = await tenantA.get(`/v1/orders/${order.id}`);
    expect((stillWaiting.body as { status: string }).status).toBe('AWAITING_RECEIPT_CONFIRMATION');
    // And the money has not moved.
    const stillHeld = await tenantA.get('/v1/wallets/me');
    expect(minor((stillHeld.body as { pendingBalanceMinor: string }).pendingBalanceMinor)).toBe(
      pendingBefore + 900_000n,
    );

    // ---- the buyer confirms, and only then does settlement happen ---------
    const receipt = await tenantA.post(`/v1/orders/${order.id}/confirm-receipt`, {
      idempotencyKey: idempotencyKey('e2e-receipt'),
      body: {},
    });
    expect(receipt.status).toBe(200);

    const completed = await until(tenantA, order.id, ['COMPLETED']);
    expect(completed.economicSettlementId).toBeTruthy();

    // ---- the money actually moved ----------------------------------------
    const walletAfter = await tenantA.get('/v1/wallets/me');
    const closing = walletAfter.body as {
      availableBalanceMinor: string;
      pendingBalanceMinor: string;
    };
    // The escrow is gone — settled, not still held — and what was spendable is
    // down by exactly the order total, which was committed at hold time.
    expect(minor(closing.pendingBalanceMinor)).toBe(pendingBefore);
    expect(minor(closing.availableBalanceMinor)).toBe(availableBefore - 900_000n);

    // ---- and the ledger records it ---------------------------------------
    const transaction = await tenantA.get(
      `/v1/transactions/${String(completed.economicTransactionId)}`,
    );
    expect(transaction.status).toBe(200);
    const settled = transaction.body as {
      status: string;
      grossAmountMinor: string;
      commissionAmountMinor: string;
      netAmountMinor: string;
      sourceReference: string | null;
    };

    expect(settled.status).toBe('SETTLED');
    expect(minor(settled.grossAmountMinor)).toBe(900_000n);
    // Gross = commission + net, whatever the configured rate is. The rate
    // itself is economic-service's business; this service does not know it.
    expect(minor(settled.commissionAmountMinor) + minor(settled.netAmountMinor)).toBe(900_000n);
    // The obligation names the order it came from, so an auditor can walk from
    // a ledger entry back to the purchase without a cross-service join.
    expect(settled.sourceReference).toBe(order.id);
  });

  test('permits a review only after the order completed', async ({ tenantA }) => {
    const list = await tenantA.get('/v1/orders?role=BUYER&status=COMPLETED&limit=5');
    const completed = (list.body as { items: { id: string }[] }).items[0];
    expect(completed).toBeDefined();

    const review = await tenantA.post(`/v1/orders/${completed!.id}/reviews`, {
      idempotencyKey: idempotencyKey('e2e-review'),
      body: { rating: 5, comment: 'تحویل به‌موقع' },
    });
    expect(review.status).toBe(201);

    // One review per order.
    const second = await tenantA.post(`/v1/orders/${completed!.id}/reviews`, {
      idempotencyKey: idempotencyKey('e2e-review-2'),
      body: { rating: 1 },
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
