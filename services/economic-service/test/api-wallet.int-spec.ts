import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, auditor, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The wallet and payment HTTP surface, every path including the refusals.
 *
 * docs/14 § 14.5: "پوشش الزامی به‌ازای هر Endpoint: مسیر موفق · ورودی نامعتبر
 * (۴۰۰) · بدون توکن (۴۰۱) · نقش نادرست (۴۰۳) · مستأجر دیگر (۴۰۴)". Each of
 * those is a row below, against a real database and the real simulated
 * provider.
 */
describe('wallet API', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('WALLET-A');
  const other = apiTenant('WALLET-B');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, other]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Provider disclosure
  // -------------------------------------------------------------------------

  it('discloses that the payment provider is simulated', async () => {
    // ADR-024 requires the simulated nature to be visible in the API. A client
    // that cannot ask cannot show it, and silence would itself be a claim.
    const response = await request(http)
      .get('/v1/wallets/provider')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    expect(response.body.simulated).toBe(true);
    expect(response.body.provider).toBe('mock');
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it('opens the wallet on first use and reports three balances', async () => {
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    expect(response.body.organizationId).toBe(org);
    expect(response.body.status).toBe('ACTIVE');
    // Every amount crosses the wire as a string in minor units (ADR-022).
    expect(typeof response.body.availableBalanceMinor).toBe('string');
    expect(BigInt(response.body.availableBalanceMinor)).toBe(
      BigInt(response.body.ledgerBalanceMinor) - BigInt(response.body.pendingBalanceMinor),
    );
  });

  it('reads the same wallet by id, and lists its holds', async () => {
    const me = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const byId = await request(http)
      .get(`/v1/wallets/${me.body.id}`)
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(byId.body.id).toBe(me.body.id);

    const holds = await request(http)
      .get(`/v1/wallets/${me.body.id}/holds?status=ACTIVE`)
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(Array.isArray(holds.body.items)).toBe(true);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    // The schemas are `.strict()`. A caller who misspells `currency` should be
    // told, not silently served the default — a wallet in the wrong currency
    // is a financial answer to a question nobody asked.
    const response = await request(http)
      .get('/v1/wallets/me?currncy=IRR')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('refuses a caller with no token', async () => {
    const response = await request(http).get('/v1/wallets/me').expect(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses the oversight role every wallet route', async () => {
    // CONSTRAINT (product document ch. 4, docs/10 § 10.13): province oversight
    // is aggregate only. Not read-only here — none.
    const token = `Bearer ${auditor(org)}`;
    await request(http).get('/v1/wallets/me').set('authorization', token).expect(403);
    await request(http).get('/v1/wallets/provider').set('authorization', token).expect(403);
  });

  it("returns 404, not 403, for another organization's wallet", async () => {
    const mine = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    // Opening the other tenant's wallet first, so this is genuinely a refusal
    // between two organizations that both exist.
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(other)}`)
      .expect(200);

    const response = await request(http)
      .get(`/v1/wallets/${mine.body.id}`)
      .set('authorization', `Bearer ${admin(other)}`)
      .expect(404);

    // A 403 would confirm the wallet exists, and identifiers could then be
    // walked to map who holds money with whom (docs/09).
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('refuses a request whose token names an organization it has no membership in', async () => {
    const response = await request(http)
      .get('/v1/wallets/me')
      .set(
        'authorization',
        `Bearer ${bearer({ sub: 'x', organizationId: org, roles: ['ORGANIZATION_ADMIN'], organizationIds: [org] })}`,
      )
      .set('x-organization-id', other)
      .expect(403);

    expect(response.body.code).toBe('TENANT_MISMATCH');
  });

  // -------------------------------------------------------------------------
  // Top-up
  // -------------------------------------------------------------------------

  it('funds the wallet through the provider and credits only on capture', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const before = BigInt(wallet.body.ledgerBalanceMinor);

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-topup'))
      .send({ amountMinor: '5000000' })
      .expect(201);

    expect(response.body.status).toBe('CAPTURED');
    expect(response.body.simulated).toBe(true);
    expect(BigInt(response.body.balances.ledgerBalanceMinor)).toBe(before + 5_000_000n);
  });

  it('reports a provider failure without moving money', async () => {
    // The failure is asked for by the request rather than arriving one call in
    // twenty, which is what makes this path reachable at all instead of flaky.
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    const before = BigInt(wallet.body.ledgerBalanceMinor);

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-topup-fail'))
      .send({ amountMinor: '9000', instrument: 'fail:INSUFFICIENT_FUNDS' })
      .expect(201);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.failureReason).toContain('INSUFFICIENT_FUNDS');

    const after = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    // The wallet is credited on capture, never on authorisation, so a failure
    // leaves no balance to claw back.
    expect(BigInt(after.body.ledgerBalanceMinor)).toBe(before);
  });

  it('reports a capture failure the same way', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    const before = BigInt(wallet.body.ledgerBalanceMinor);

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-capture-fail'))
      .send({ amountMinor: '9000', instrument: 'fail-capture:PROVIDER_DECLINED' })
      .expect(201);

    expect(response.body.status).toBe('FAILED');

    const after = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(BigInt(after.body.ledgerBalanceMinor)).toBe(before);
  });

  it('refuses a top-up with no Idempotency-Key', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .send({ amountMinor: '1000' })
      .expect(400);

    // A key the server invents is useless: the client's retry would carry a
    // different one and charge twice (docs/06 § 6.8).
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('returns the first response for a repeated key, and 409 for a changed body', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const key = id('api-topup-replay');
    const first = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', key)
      .send({ amountMinor: '3000' })
      .expect(201);

    const replay = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', key)
      .send({ amountMinor: '3000' })
      .expect(201);
    expect(replay.body.paymentIntentId).toBe(first.body.paymentIntentId);

    const conflict = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', key)
      .send({ amountMinor: '4000' })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a non-positive amount', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-topup-zero'))
      .send({ amountMinor: '0' })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  // -------------------------------------------------------------------------
  // Payment intents
  // -------------------------------------------------------------------------

  it('lists and reads the payment intents a top-up produced', async () => {
    const list = await request(http)
      .get('/v1/payment-intents?limit=5')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    expect(list.body.items.length).toBeGreaterThan(0);
    const intent = list.body.items[0];
    expect(intent.organizationId).toBe(org);
    expect(intent.simulated).toBe(true);

    const one = await request(http)
      .get(`/v1/payment-intents/${intent.id}`)
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(one.body.id).toBe(intent.id);

    // Another tenant sees nothing of it.
    await request(http)
      .get(`/v1/payment-intents/${intent.id}`)
      .set('authorization', `Bearer ${admin(other)}`)
      .expect(404);
  });

  it('refuses a refund to anyone below platform scope, and refunds for one above', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    const topUp = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-refundable'))
      .send({ amountMinor: '7000' })
      .expect(201);

    await request(http)
      .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-refund-denied'))
      .send({ reason: 'attempted by an organization administrator' })
      .expect(403);

    const refunded = await request(http)
      .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
      .set('authorization', `Bearer ${platformAdminFor(org)}`)
      .set('idempotency-key', id('api-refund'))
      .send({ reason: 'refunded by a platform administrator in a test' })
      .expect(200);

    // A refund posts a **reversal** of the top-up journal rather than editing
    // it: history is untouched, and both entries remain for an auditor to see
    // (AGENTS.md A-06).
    expect(refunded.body.reversalJournalId).toBeTruthy();
    expect(refunded.body.simulated).toBe(true);
    expect(BigInt(refunded.body.amountMinor)).toBe(7000n);

    const intent = await request(http)
      .get(`/v1/payment-intents/${topUp.body.paymentIntentId}`)
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);
    expect(intent.body.status).toBe('REFUNDED');
  });

  // A platform administrator that is also a member of the tenant, which is
  // what an operator resolving a stuck payment actually looks like.
  function platformAdminFor(organizationId: string): string {
    return bearer({
      sub: `sub-platform-${organizationId}`,
      rastaUserId: 'USR-APITEST-PLATFORM',
      organizationId,
      organizationIds: [organizationId],
      roles: ['UNION_ADMIN'],
    });
  }
});
