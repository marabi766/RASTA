import { inspect } from 'node:util';
import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, auditor, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { EXCEPTION_FILTER_LOGGER, runUnscoped, type JsonSchema } from '@rasta/nest-common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { schemaMismatches } from '../src/openapi/schema-mismatches';

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

  describe('the disclosure every money screen asks (Q-14)', () => {
    const asked = (token: string) =>
      request(http).get('/v1/wallets/provider/disclosure').set('authorization', `Bearer ${token}`);

    it.each([
      ['a contractor, with no other role', ['CONTRACTOR']],
      ['a plain member: a driver', ['DRIVER']],
      ['a plain member: an operator', ['OPERATOR']],
      ['a workshop', ['WORKSHOP']],
      ['a supplier', ['SUPPLIER']],
      ['a procurement user', ['PROCUREMENT_USER']],
      ['a fleet manager', ['FLEET_MANAGER']],
      ['an organization administrator', ['ORGANIZATION_ADMIN']],
    ])('answers %s with `simulated` alone', async (_who, roles) => {
      const response = await asked(admin(org, roles)).expect(200);
      // Not the provider's name or notice: those stay behind `GET /v1/wallets/provider`.
      expect(response.body).toEqual({ simulated: true });
    });

    it('widens nothing else: the same contractor and driver are still refused the provider and the wallet', async () => {
      for (const roles of [['CONTRACTOR'], ['DRIVER']]) {
        const token = `Bearer ${admin(org, roles)}`;
        await request(http).get('/v1/wallets/provider').set('authorization', token).expect(403);
        await request(http).get('/v1/wallets/me').set('authorization', token).expect(403);
      }
    });

    it('is tenant-scoped: refused for an organization the caller is not a member of, and to the oversight role', async () => {
      const response = await request(http)
        .get('/v1/wallets/provider/disclosure')
        .set('authorization', `Bearer ${admin(org, ['CONTRACTOR'])}`)
        .set('x-organization-id', other)
        .expect(403);
      expect(response.body.code).toBe('TENANT_MISMATCH');
      await asked(auditor(org)).expect(403);
      // A membership that grants no role grants nothing on the platform (ADR-060 § 4), this read
      // included: such a caller reaches no money screen to label.
      expect((await asked(admin(org, [])).expect(403)).body.code).toBe('TENANT_MISMATCH');
      await request(http).get('/v1/wallets/provider/disclosure').expect(401);
    });

    it('answers what the OpenAPI document says, both ways', async () => {
      const document = enrichOpenApiDocument(
        SwaggerModule.createDocument(
          harness.app,
          new DocumentBuilder().setTitle('t').setVersion('0.0.0').build(),
        ),
      );
      const responses = document.paths['/v1/wallets/provider/disclosure']?.get?.responses ?? {};
      expect(Object.keys(responses).sort()).toEqual(['200', '401', '403', '500']);
      const schema = (
        responses['200'] as unknown as { content: Record<string, { schema: JsonSchema }> }
      ).content['application/json']!.schema;
      expect(schema).toEqual({ $ref: '#/components/schemas/PaymentDisclosure' });

      const response = await asked(admin(org, ['CONTRACTOR'])).expect(200);
      const components = (document.components?.schemas ?? {}) as Record<string, JsonSchema>;
      expect(
        schemaMismatches(schema, response.body, 'GET /v1/wallets/provider/disclosure', components),
      ).toEqual([]);
      // And the check is not vacuous: a field the document does not carry is refused.
      expect(
        schemaMismatches(schema, { ...response.body, provider: 'mock' }, 'x', components),
      ).not.toEqual([]);
    });
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

    // ADR-036 on the two phases of one payment. The authorisation happened
    // before any transaction existed — `PaymentIntent.transaction_id` is
    // written at capture — so it is keyed by the intent, and the capture, which
    // does have a transaction, is keyed by that.
    const intentId = response.body.paymentIntentId as string;
    const rows = await runUnscoped('the suite reads the outbox it produced', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: {
          organizationId: org,
          eventName: { in: ['PAYMENT_AUTHORIZED', 'PAYMENT_COMPLETED'] },
        },
      }),
    );

    const forThisIntent = rows.filter(
      (row) =>
        (row.payload as { payload?: { paymentIntentId?: string } })?.payload?.paymentIntentId ===
        intentId,
    );

    const authorised = forThisIntent.find((row) => row.eventName === 'PAYMENT_AUTHORIZED');
    const completed = forThisIntent.find((row) => row.eventName === 'PAYMENT_COMPLETED');

    expect(authorised?.partitionKey).toBe(intentId);
    expect(completed?.partitionKey).toBe(response.body.transactionId);
    // No invented transaction id: the authorisation payload has no such field
    // at all, and giving it one would be a falsehood in a financial payload.
    expect(
      (authorised?.payload as { payload?: Record<string, unknown> })?.payload,
    ).not.toHaveProperty('transactionId');
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

  // Task 011: the positivity refinement ran after the pattern had failed and `BigInt('1.5')`
  // threw out of the validation pipe — a 500, with the client's text in the error log (#385 r1
  // F1 reproduced it with an invoice reference). Through the real AppModule, guards and filter,
  // with a token that reaches the validator.
  describe('a malformed top-up amount', () => {
    const SENTINEL = 'private-invoice-reference-123';

    /** Every line the service could write: the filter's logger at each level, and the streams. */
    function captureLogs(): { text: () => string; restore: () => void } {
      const logger = harness.app.get<Record<string, unknown>>(EXCEPTION_FILTER_LOGGER);
      const spies = [
        ...['fatal', 'error', 'warn', 'info', 'debug', 'trace']
          .filter((level) => typeof logger[level] === 'function')
          .map((level) => jest.spyOn(logger as Record<string, () => void>, level)),
        jest.spyOn(process.stdout, 'write'),
        jest.spyOn(process.stderr, 'write'),
      ];
      return {
        text: () =>
          inspect(
            spies.flatMap((spy): unknown[][] => spy.mock.calls),
            { depth: null, maxStringLength: null },
          ),
        restore: () => spies.forEach((spy) => spy.mockRestore()),
      };
    }

    const intentsOf = (organizationId: string) =>
      runUnscoped('the suite counts the intents a refusal must not create', () =>
        harness.prisma.client.paymentIntent.count({ where: { organizationId } }),
      );
    const keysOf = (key: string) =>
      runUnscoped('the suite looks for the key a refusal must not reserve', () =>
        harness.prisma.client.idempotencyKey.count({ where: { key } }),
      );

    it.each([
      ['a fraction', '1.5'],
      ['letters', 'abc'],
      ['nothing', ''],
      ['free text', SENTINEL],
    ])(
      'refuses %s with the standard 400 — nothing charged, no key reserved, the text in no log line',
      async (_label, amountMinor) => {
        const wallet = await request(http)
          .get('/v1/wallets/me')
          .set('authorization', `Bearer ${admin(org)}`)
          .expect(200);
        const intentsBefore = await intentsOf(org);
        const key = id('api-topup-malformed');
        const logs = captureLogs();

        let response: request.Response;
        try {
          response = await request(http)
            .post(`/v1/wallets/${wallet.body.id}/top-up`)
            .set('authorization', `Bearer ${admin(org)}`)
            .set('idempotency-key', key)
            .send({ amountMinor })
            .expect(400);
          expect(logs.text()).not.toContain(SENTINEL);
        } finally {
          logs.restore();
        }

        expect(response.body).toEqual({
          code: 'VALIDATION_FAILED',
          message: expect.any(String),
          details: [
            {
              path: 'amountMinor',
              code: 'invalid_string',
              message: 'Amount must be a non-negative integer string in minor units',
            },
          ],
          correlationId: expect.any(String),
          timestamp: expect.any(String),
          path: `/v1/wallets/${wallet.body.id}/top-up`,
        });
        expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
        expect(await intentsOf(org)).toBe(intentsBefore);
        expect(await keysOf(key)).toBe(0);
      },
    );

    it('lets the corrected request under the same key charge once, and replays it after', async () => {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(org)}`)
        .expect(200);
      const before = BigInt(wallet.body.ledgerBalanceMinor);
      const intentsBefore = await intentsOf(org);
      const key = id('api-topup-corrected');
      const topUp = (amountMinor: string) =>
        request(http)
          .post(`/v1/wallets/${wallet.body.id}/top-up`)
          .set('authorization', `Bearer ${admin(org)}`)
          .set('idempotency-key', key)
          .send({ amountMinor });

      await topUp('12.5').expect(400);
      const first = await topUp('125').expect(201);
      const replay = await topUp('125').expect(201);

      expect(replay.body.paymentIntentId).toBe(first.body.paymentIntentId);
      expect(await intentsOf(org)).toBe(intentsBefore + 1);
      const after = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(org)}`)
        .expect(200);
      expect(BigInt(after.body.ledgerBalanceMinor)).toBe(before + 125n);
    });

    it('refuses zero, accepts one, and refuses one past a BIGINT, as before', async () => {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(org)}`)
        .expect(200);
      const send = (amountMinor: string) =>
        request(http)
          .post(`/v1/wallets/${wallet.body.id}/top-up`)
          .set('authorization', `Bearer ${admin(org)}`)
          .set('idempotency-key', id('api-topup-bound'))
          .send({ amountMinor });

      const zero = await send('0').expect(400);
      expect(zero.body.details).toEqual([
        { path: 'amountMinor', code: 'custom', message: 'A top-up must be positive' },
      ]);
      await send('1').expect(201);
      const past = await send('9223372036854775808').expect(400);
      expect(past.body.details).toEqual([
        {
          path: 'amountMinor',
          code: 'custom',
          message: 'Amount exceeds the largest storable amount (2^63 - 1 minor units)',
        },
      ]);
    });

    it('still keeps another organization’s wallet out of reach: 404 for a good amount', async () => {
      const theirs = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(other)}`)
        .expect(200);
      const intentsBefore = await intentsOf(other);

      const response = await request(http)
        .post(`/v1/wallets/${theirs.body.id}/top-up`)
        .set('authorization', `Bearer ${admin(org)}`)
        .set('idempotency-key', id('api-topup-foreign'))
        .send({ amountMinor: '1000' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(await intentsOf(other)).toBe(intentsBefore);
    });
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
