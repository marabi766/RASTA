import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A transaction's dispute follows its source (docs/24 Q-138), and the dispute
 * keeps its reason when it is resolved.
 *
 * An order's obligation (`MARKETPLACE_ORDER`) is disputed through the order —
 * marketplace-service records the outcome and who was responsible, and its
 * saga mirrors the dispute and the resolution onto the transaction with its
 * own service token. Nobody else may dispute or resolve that transaction
 * directly: not its payer, not a union administrator, not a system
 * administrator. Every other type is disputed on the transaction, as before.
 *
 * The saga's calls here are made exactly as `EconomicClient` makes them: a
 * marketplace-service token signed for the buyer, and the keys
 * `order:<id>:dispute:<disputeId>` and `order:<id>:resolve-dispute:<disputeId>`.
 */
describe('transaction disputes follow the source (Q-138) and keep the reason', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('DSRC-PAYER');
  const payee = apiTenant('DSRC-PAYEE');
  const stranger = apiTenant('DSRC-STRANGER');
  const platform = apiTenant('DSRC-PLATFORM');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asStranger = () => `Bearer ${admin(stranger)}`;
  const asUnionAdmin = () => `Bearer ${admin(platform, ['UNION_ADMIN'])}`;
  const asSystemAdmin = () => `Bearer ${admin(platform, ['SYSTEM_ADMIN'])}`;
  /** A system administrator acting as the payer itself. */
  const asSystemAdminOfPayer = () => `Bearer ${admin(payer, ['SYSTEM_ADMIN'])}`;
  const saga = (organizationId = payer) => internalToken('marketplace-service', { organizationId });

  const REASON = 'The delivered quantity does not match the recorded order.';
  const RESOLUTION = 'The delivery note confirms the full quantity was received.';
  const REFUSAL =
    'A marketplace order’s transaction is disputed and resolved only through the order';

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('dsrc-fund'))
      .send({ amountMinor: '50000000' })
      .expect(201);
    for (const token of [asPayee(), asStranger()]) {
      await request(http).get('/v1/wallets/me').set('authorization', token).expect(200);
    }
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, stranger, platform]);
    await harness.close();
  });

  /** An order's obligation, recorded and held by the saga as `createObligation` does. */
  async function orderObligation(): Promise<{ orderId: string; transactionId: string }> {
    const orderId = `ORD_${ulid()}`;
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await saga())
      .set('idempotency-key', `order:${orderId}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '7000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: orderId,
        holdFunds: true,
      })
      .expect(201);
    expect(created.body.status).toBe('HELD');
    return { orderId, transactionId: created.body.id as string };
  }

  /** Any other obligation, recorded and held by its payer. */
  async function logisticsObligation(): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('dsrc-logistics'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '5000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    return created.body.id as string;
  }

  function dispute(transactionId: string, auth: string, key = id('dsrc-dispute')): request.Test {
    return request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set(...header(auth))
      .set('idempotency-key', key)
      .send({ reason: REASON });
  }

  function resolve(transactionId: string, auth: string, key = id('dsrc-resolve')): request.Test {
    return request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set(...header(auth))
      .set('idempotency-key', key)
      .send({ resolution: RESOLUTION });
  }

  /** A person's bearer token goes in `authorization`, the saga's in `x-internal-token`. */
  function header(auth: string): [string, string] {
    return auth.startsWith('Bearer ') ? ['authorization', auth] : ['x-internal-token', auth];
  }

  async function read(transactionId: string) {
    const response = await request(http)
      .get(`/v1/transactions/${transactionId}`)
      .set('authorization', asPayer())
      .expect(200);
    return response.body as Record<string, unknown>;
  }

  /** The lifecycle records of one transaction, oldest first. */
  async function statusChanges(transactionId: string): Promise<string[]> {
    const rows = await runUnscoped('the suite reads the outbox it produced', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { aggregateId: transactionId, eventName: 'TRANSACTION_STATUS_CHANGED' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => (row.payload as { payload: { action: string } }).payload.action);
  }

  // -------------------------------------------------------------------------
  // MARKETPLACE_ORDER: only the order saga
  // -------------------------------------------------------------------------

  describe('an order’s obligation', () => {
    it.each([
      ['the payer’s administrator', asPayer],
      ['a union administrator', asUnionAdmin],
      ['a system administrator', asSystemAdmin],
      ['a system administrator acting as the payer', asSystemAdminOfPayer],
    ])('refuses a dispute by %s — 422, nothing moved', async (_, as) => {
      const { transactionId } = await orderObligation();

      const refused = await dispute(transactionId, as()).expect(422);

      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refused.body.message).toBe(REFUSAL);
      // The platform envelope and nothing else: no details, no internal names.
      expect(Object.keys(refused.body).sort()).toEqual([
        'code',
        'correlationId',
        'message',
        'path',
        'timestamp',
      ]);
      expect(refused.body.path).toBe(`/v1/transactions/${transactionId}/dispute`);
      expect(JSON.stringify(refused.body)).not.toMatch(/marketplace-service|ORG-APITEST/);
      const after = await read(transactionId);
      expect(after.status).toBe('HELD');
      expect(after.disputedAt).toBeNull();
      expect(after.disputeReason).toBeNull();
      expect(await statusChanges(transactionId)).toEqual(['CREATE']);
    });

    it.each([
      ['a union administrator', asUnionAdmin, 422],
      ['a system administrator', asSystemAdmin, 422],
      ['a system administrator acting as the payer', asSystemAdminOfPayer, 422],
      // The route's roles already exclude an organization administrator.
      ['the payer’s administrator', asPayer, 403],
    ])(
      'refuses the resolution of the saga’s dispute by %s, leaving it DISPUTED',
      async (_, as, status) => {
        const { orderId, transactionId } = await orderObligation();
        const disputeId = `DSP_${ulid()}`;
        await dispute(transactionId, await saga(), `order:${orderId}:dispute:${disputeId}`).expect(
          200,
        );

        const refused = await resolve(transactionId, as()).expect(status);

        if (status === 422) {
          expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
          expect(refused.body.message).toBe(REFUSAL);
        }
        const after = await read(transactionId);
        expect(after.status).toBe('DISPUTED');
        expect(after.disputeResolvedAt).toBeNull();
        expect(after.disputeResolution).toBeNull();
      },
    );

    it('lets the saga dispute and resolve it, with its own keys, and keeps the reason', async () => {
      const { orderId, transactionId } = await orderObligation();
      const disputeId = `DSP_${ulid()}`;
      const disputeKey = `order:${orderId}:dispute:${disputeId}`;
      const resolveKey = `order:${orderId}:resolve-dispute:${disputeId}`;

      const disputed = await dispute(transactionId, await saga(), disputeKey).expect(200);
      expect(disputed.body).toMatchObject({
        status: 'DISPUTED',
        disputeReason: REASON,
        // A service caller is recorded as this service, as before.
        disputedBy: 'economic-service',
        disputeResolvedAt: null,
        disputeResolvedBy: null,
        disputeResolution: null,
      });
      expect(typeof disputed.body.disputedAt).toBe('string');

      // The saga's retry is a replay of its own answer.
      const replayed = await dispute(transactionId, await saga(), disputeKey).expect(200);
      expect(replayed.body).toEqual(disputed.body);

      const resolved = await resolve(transactionId, await saga(), resolveKey).expect(200);
      expect(resolved.body).toMatchObject({
        status: 'PENDING_SETTLEMENT',
        disputeReason: REASON,
        disputeResolution: RESOLUTION,
        disputeResolvedBy: 'economic-service',
        disputedAt: disputed.body.disputedAt,
      });
      expect(typeof resolved.body.disputeResolvedAt).toBe('string');

      const replayedResolution = await resolve(transactionId, await saga(), resolveKey).expect(200);
      expect(replayedResolution.body).toEqual(resolved.body);

      expect(await read(transactionId)).toMatchObject({
        disputeReason: REASON,
        disputeResolution: RESOLUTION,
      });
      expect(await statusChanges(transactionId)).toEqual(['CREATE', 'DISPUTE', 'RESOLVE_DISPUTE']);
    });

    it('lets the saga dispute the same order again, with a new dispute id', async () => {
      // RECEIPT_CONFIRMED → DISPUTED is legal on the order, so the saga may
      // mirror a second dispute after the first was resolved.
      const { orderId, transactionId } = await orderObligation();
      const first = `DSP_${ulid()}`;
      await dispute(transactionId, await saga(), `order:${orderId}:dispute:${first}`).expect(200);
      await resolve(
        transactionId,
        await saga(),
        `order:${orderId}:resolve-dispute:${first}`,
      ).expect(200);

      const second = await request(http)
        .post(`/v1/transactions/${transactionId}/dispute`)
        .set('x-internal-token', await saga())
        .set('idempotency-key', `order:${orderId}:dispute:DSP_${ulid()}`)
        .send({ reason: 'A second objection about the same delivery.' })
        .expect(200);

      expect(second.body.status).toBe('DISPUTED');
      expect(second.body.disputeReason).toBe('A second objection about the same delivery.');
      // The earlier resolution stays, and is older than the new dispute.
      expect(second.body.disputeResolution).toBe(RESOLUTION);
      expect(Date.parse(second.body.disputeResolvedAt)).toBeLessThanOrEqual(
        Date.parse(second.body.disputedAt),
      );
    });

    it('refuses a person’s replay of a dispute stored before the rule, as the command would', async () => {
      // A person's stored answer for a dispute on an order's obligation can
      // only predate this rule. Modelled by disputing another type and then
      // giving the row the order type: the replay is refused exactly as the
      // command would be, rather than answered.
      const transactionId = await logisticsObligation();
      const key = id('dsrc-replay');
      await dispute(transactionId, asPayer(), key).expect(200);
      await runUnscoped('the suite models a dispute stored before Q-138', () =>
        harness.prisma.client.transaction.update({
          where: { id: transactionId },
          data: { transactionType: 'MARKETPLACE_ORDER' },
        }),
      );

      const replay = await dispute(transactionId, asPayer(), key).expect(422);
      expect(replay.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(replay.body.message).toBe(REFUSAL);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation: the source rule says nothing to a non-party
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('answers a stranger 404 — never the source refusal', async () => {
      const { transactionId } = await orderObligation();

      const disputeRefusal = await dispute(transactionId, asStranger()).expect(404);
      expect(disputeRefusal.body.code).toBe('NOT_FOUND');

      const missing = await dispute('TXN_0000000000000000000000000', asStranger()).expect(404);
      expect(disputeRefusal.body.message).toBe(missing.body.message);
    });

    it('answers the saga 404 when its token is signed for an organization that is not a party', async () => {
      const { orderId, transactionId } = await orderObligation();
      const disputeId = `DSP_${ulid()}`;

      const refused = await dispute(
        transactionId,
        await saga(stranger),
        `order:${orderId}:dispute:${disputeId}`,
      ).expect(404);
      expect(refused.body.code).toBe('NOT_FOUND');

      // Signed for the buyer, the same call succeeds: the tenant check is what
      // refused it, not the source.
      await dispute(transactionId, await saga(), `order:${orderId}:dispute:${disputeId}`).expect(
        200,
      );
    });

    it('refuses the payee’s administrator as before — 403 TENANT_MISMATCH', async () => {
      const { transactionId } = await orderObligation();

      const refused = await dispute(transactionId, asPayee()).expect(403);
      expect(refused.body.code).toBe('TENANT_MISMATCH');
    });

    it('refuses another service at the route — 403', async () => {
      const { transactionId } = await orderObligation();
      const contract = await internalToken('contract-service', { organizationId: payer });

      await dispute(transactionId, contract).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Every other source: unchanged, and the reason survives the resolution
  // -------------------------------------------------------------------------

  describe('any other source', () => {
    it.each([
      ['a union administrator', asUnionAdmin],
      ['a system administrator', asSystemAdmin],
    ])(
      'is disputed by its payer and resolved by %s, keeping the reason beside the resolution',
      async (_, resolver) => {
        const transactionId = await logisticsObligation();

        const disputed = await dispute(transactionId, asPayer()).expect(200);
        expect(disputed.body).toMatchObject({
          status: 'DISPUTED',
          disputeReason: REASON,
          disputedBy: expect.stringMatching(/^USR-APITEST-/),
          disputeResolution: null,
        });

        const resolved = await resolve(transactionId, resolver()).expect(200);
        expect(resolved.body).toMatchObject({
          status: 'PENDING_SETTLEMENT',
          disputeReason: REASON,
          disputeResolution: RESOLUTION,
          disputeResolvedBy: expect.stringMatching(/^USR-APITEST-/),
        });
        expect(resolved.body.disputeResolvedBy).not.toBe(disputed.body.disputedBy);

        // The list carries the same fields.
        const listed = await request(http)
          .get('/v1/transactions?limit=100')
          .set('authorization', asPayer())
          .expect(200);
        const row = (listed.body.items as Record<string, unknown>[]).find(
          (item) => item.id === transactionId,
        );
        expect(row).toMatchObject({
          disputedBy: disputed.body.disputedBy,
          disputeReason: REASON,
          disputeResolvedAt: resolved.body.disputeResolvedAt,
          disputeResolvedBy: resolved.body.disputeResolvedBy,
          disputeResolution: RESOLUTION,
        });
      },
    );

    it('is refused to the saga only by the usual rules, not by the source rule', async () => {
      // The saga's token reaches a non-order transaction of its payer like any
      // other committer: the rule is about the source, not about the caller.
      const transactionId = await logisticsObligation();

      await dispute(transactionId, await saga(), id('dsrc-saga-other')).expect(200);
    });
  });
});
