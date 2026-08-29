import { test, expect, idempotencyKey, minor } from '../../src/api';
import { ORG } from '../../src/env';
import { EconomicEventTap } from '../../src/events';

/**
 * Scenario 5 — one correlation identifier, from the HTTP request to the topic.
 *
 * A request the client can name, and events an operator can find from that
 * name. AGENTS.md § 7 requires it ("رویدادهای مهم با Correlation ID ثبت
 * می‌شوند") and it is the property that makes a financial incident
 * investigable at all: without it, "the customer says their settlement failed"
 * cannot be turned into the journal, the events and the ledger entries that
 * followed.
 *
 * It is asserted against the **real broker**, because that hop is where a
 * correlation chain usually breaks and nothing downstream fails loudly when it
 * does. The outbox row could carry the identifier perfectly and the Kafka
 * header still be empty, and every test that stopped at the HTTP response
 * would still be green.
 */
test.describe.serial('Correlation across the request and event path', () => {
  let tap: EconomicEventTap;

  test.beforeAll(async () => {
    tap = await EconomicEventTap.start();
  });

  test.afterAll(async () => {
    await tap?.stop();
  });

  test('the gateway echoes the correlation id the client chose', async ({ tenantA }) => {
    const response = await tenantA.get('/v1/wallets/me');

    expect(response.status).toBe(200);
    expect(response.headers['x-correlation-id']).toBe(response.correlationId);
    // A request id is minted per hop and is never the client's to choose; both
    // are echoed so a user can quote one and an operator can find the other.
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-request-id']).not.toBe(response.correlationId);
  });

  test('a funded hold carries that identifier into every event it produces', async ({
    tenantA,
  }) => {
    const correlationId = `e2e-corr-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;

    const wallet = await tenantA.get('/v1/wallets/me', { correlationId });
    const walletId = (wallet.body as { id: string }).id;

    // Two writes under one correlation id — a top-up and an obligation with a
    // hold. Between them they produce a payment, a journal and an escrow
    // movement, which is enough to prove the identifier is not attached by one
    // lucky code path.
    const topUp = await tenantA.post(`/v1/wallets/${walletId}/top-up`, {
      correlationId,
      idempotencyKey: idempotencyKey('corr-topup'),
      body: { amountMinor: '25000000' },
    });
    expect(topUp.status).toBe(201);
    expect(topUp.headers['x-correlation-id']).toBe(correlationId);

    const key = idempotencyKey('corr-hold');
    const created = await tenantA.post('/v1/transactions', {
      correlationId,
      idempotencyKey: key,
      body: {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '3000000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: true,
      },
    });
    expect(created.status).toBe(201);
    const transactionId = (created.body as { id: string }).id;

    // The outbox relay polls, so this is a wait on a condition rather than a
    // sleep — docs/14 § 14.7 forbids fixed sleeps, and a sleep long enough to
    // be reliable is always long enough to be slow.
    const events = await tap.awaitCorrelated(correlationId, [
      'PAYMENT_AUTHORIZED',
      'PAYMENT_COMPLETED',
      'JOURNAL_POSTED',
      'FUNDS_HELD',
    ]);

    // Every event under this identifier belongs to the tenant that made the
    // request — the envelope's tenant header is not decoration, it is what a
    // consumer scopes by.
    for (const event of events) {
      // Both places it is carried, independently: the Kafka header a consumer
      // filters on without deserialising, and the envelope it records once it
      // has. A break in either is a break in the chain.
      expect(event.correlationId).toBe(correlationId);
      expect(event.envelopeCorrelationId).toBe(correlationId);
      expect(event.tenantId).toBe(ORG.a);
    }

    const held = events.find((event) => event.eventName === 'FUNDS_HELD');
    expect(held).toBeDefined();
    expect(held!.payload.transactionId).toBe(transactionId);
    expect(minor(held!.payload.amountMinor)).toBe(3_000_000n);
    // Keyed by the hold, which is the aggregate this event is about
    // (`LedgerService.enqueue` partitions by aggregate id). Asserted rather
    // than assumed, because `kafka.publisher.ts` describes a stronger
    // guarantee than the code gives — see docs/24 Q-26.
    expect(held!.key).toBe(held!.payload.holdId);

    const payment = events.find((event) => event.eventName === 'PAYMENT_COMPLETED');
    // ADR-024: silence would itself be a claim. Every payment event states
    // that no real money moved.
    expect(payment!.payload.simulated).toBe(true);
  });

  test('a settlement continues the same chain', async ({ tenantA }) => {
    const correlationId = `e2e-corr-settle-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;

    const key = idempotencyKey('corr-settle-create');
    const created = await tenantA.post('/v1/transactions', {
      correlationId,
      idempotencyKey: key,
      body: {
        transactionType: 'MAINTENANCE_SERVICE',
        counterpartyOrganizationId: ORG.b,
        grossAmountMinor: '1500000',
        currency: 'IRR',
        sourceType: 'E2E',
        sourceReference: key,
        holdFunds: true,
      },
    });
    expect(created.status).toBe(201);
    const transactionId = (created.body as { id: string }).id;

    await tenantA.post(`/v1/transactions/${transactionId}/authorise-settlement`, {
      correlationId,
      idempotencyKey: idempotencyKey('corr-settle-auth'),
    });

    const settled = await tenantA.post('/v1/settlements', {
      correlationId,
      idempotencyKey: idempotencyKey('corr-settle'),
      body: { transactionId },
    });
    expect(settled.status).toBe(201);

    const events = await tap.awaitCorrelated(correlationId, [
      'FUNDS_HELD',
      'FUNDS_RELEASED',
      'SETTLEMENT_COMPLETED',
    ]);

    const released = events.find((event) => event.eventName === 'FUNDS_RELEASED');
    // `resolution` distinguishes released-to-the-payee from refunded-to-the-
    // payer. A consumer compensating a cancelled order and one completing a
    // fulfilled order need opposite reactions, and inferring which from the
    // absence of a later event is how a saga hangs.
    expect(released!.payload.resolution).toBe('RELEASED');

    const completed = events.find((event) => event.eventName === 'SETTLEMENT_COMPLETED');
    expect(completed!.payload.transactionId).toBe(transactionId);
    // Keyed by the **transaction**, not by the settlement id — deliberately, so
    // that a consumer rebuilding one transaction reads its settlement in the
    // partition it expects (settlement.service.ts sets `partitionKey`).
    expect(completed!.key).toBe(transactionId);
  });
});
