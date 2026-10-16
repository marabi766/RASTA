import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * What a marketplace saga step gets when it is retried after this service let
 * the command's stored answer expire (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`; D-053,
 * D-054, review of #287).
 *
 * The first attempt committed and its answer never reached the saga. Once the
 * record has expired the store holds nothing for the key: the retry is judged
 * against the state the first attempt produced, and refused for it.
 * marketplace-service reads that refusal's `code` — `INVALID_STATE_TRANSITION`
 * and nothing else — then reads the obligation as its payer and answers from
 * what it finds there. Both halves are pinned here, over HTTP, with the
 * service token and the keys the saga sends; the saga's side has its own
 * suite (`saga-activity-replay.int-spec.ts` in marketplace-service).
 */
describe('a saga command retried after its stored answer expired', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('TTL-PAYER');
  const payee = apiTenant('TTL-PAYEE');
  const asSaga = () => internalToken('marketplace-service', { organizationId: payer });

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('ttl-fund'))
      .send({ amountMinor: '30000000' })
      .expect(201);
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  /** Every answer the payer's commands left behind, aged past the TTL. */
  const expireAnswers = () =>
    runUnscoped('the suite ages the stored answers past the TTL', () =>
      harness.prisma.client.idempotencyKey.updateMany({
        where: { organizationId: payer },
        data: {
          createdAt: new Date(Date.now() - 25 * 3_600_000),
          expiresAt: new Date(Date.now() - 3_600_000),
        },
      }),
    );

  /** The order's obligation, held, as the saga's first economic step makes it. */
  async function holdFor(order: string): Promise<{ id: string }> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '500000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: order,
        holdFunds: true,
      })
      .expect(201);
    return created.body;
  }

  const authorise = async (order: string, transactionId: string) =>
    request(http)
      .post(`/v1/transactions/${transactionId}/authorise-settlement`)
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:authorise`);

  const settle = async (order: string, transactionId: string) =>
    request(http)
      .post('/v1/settlements')
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${order}:settle`)
      .send({ transactionId });

  /** `GET /v1/transactions/{id}` as the payer, with the saga's token. */
  const readAsPayer = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('x-internal-token', await asSaga())
        .expect(200)
    ).body;

  it('authorisation: refused for its own effect, and the payer reads PENDING_SETTLEMENT', async () => {
    const order = id('ORD');
    const held = await holdFor(order);

    expect((await authorise(order, held.id)).status).toBe(200);
    // Within the TTL, the stored answer.
    const replayed = await authorise(order, held.id);
    expect(replayed.status).toBe(200);
    expect(replayed.body.status).toBe('PENDING_SETTLEMENT');

    await expireAnswers();
    const retried = await authorise(order, held.id);
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('INVALID_STATE_TRANSITION');

    expect(await readAsPayer(held.id)).toMatchObject({
      id: held.id,
      organizationId: payer,
      sourceReference: order,
      transactionType: 'MARKETPLACE_ORDER',
      status: 'PENDING_SETTLEMENT',
    });
  });

  it('settlement: refused for its own effect, and the payer reads the one settlement it made', async () => {
    const order = id('ORD');
    const held = await holdFor(order);
    expect((await authorise(order, held.id)).status).toBe(200);

    const first = await settle(order, held.id);
    expect(first.status).toBe(201);

    await expireAnswers();
    const retried = await settle(order, held.id);
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('INVALID_STATE_TRANSITION');

    const read = await readAsPayer(held.id);
    expect(read).toMatchObject({
      id: held.id,
      organizationId: payer,
      sourceReference: order,
      transactionType: 'MARKETPLACE_ORDER',
      status: 'SETTLED',
      commissionAmountMinor: first.body.commissionAmountMinor,
      netAmountMinor: first.body.netAmountMinor,
    });
    expect(read.settlement.id).toBe(first.body.settlementId);

    const settlements = await runUnscoped('the suite counts the settlements', () =>
      harness.prisma.client.settlement.count({ where: { transactionId: held.id } }),
    );
    expect(settlements).toBe(1);
  });

  describe('authorised by the saga, then disputed here (Codex on #287 round 4, finding 2)', () => {
    /**
     * A dispute that is not the authorising step's: the order's, as the saga
     * mirrors it — the only way an order's transaction is disputed (the
     * product owner's answer to Q-138). Who raised it does not matter here;
     * what the record says after it does.
     */
    const disputeThroughOrder = async (transactionId: string, reason: string) =>
      request(http)
        .post(`/v1/transactions/${transactionId}/dispute`)
        .set('x-internal-token', await asSaga())
        .set('idempotency-key', `order:${id('ORD')}:dispute:${id('DSP')}`)
        .send({ reason })
        .expect(200);

    it('refused after expiry, and the payer reads DISPUTED with the saga’s own authorisation', async () => {
      const order = id('ORD');
      const held = await holdFor(order);
      expect((await authorise(order, held.id)).status).toBe(200);
      await disputeThroughOrder(held.id, 'the delivery was two pallets short');

      await expireAnswers();
      const retried = await authorise(order, held.id);
      expect(retried.status).toBe(409);
      expect(retried.body.code).toBe('INVALID_STATE_TRANSITION');

      // DISPUTED alone proves nothing; the record of the command does: the
      // saga's signed service and the key only this order's authorisation sends.
      const read = await readAsPayer(held.id);
      expect(read).toMatchObject({
        id: held.id,
        sourceReference: order,
        status: 'DISPUTED',
        disputeReason: 'the delivery was two pallets short',
        settlementAuthorisation: {
          service: 'marketplace-service',
          idempotencyKey: `order:${order}:authorise`,
        },
      });
      expect(Date.parse(read.settlementAuthorisation.authorisedAt)).not.toBeNaN();
    });

    it('a dispute from HELD carries no authorisation at all', async () => {
      const order = id('ORD');
      const held = await holdFor(order);
      await disputeThroughOrder(held.id, 'the goods never left the warehouse');

      const read = await readAsPayer(held.id);
      expect(read.status).toBe('DISPUTED');
      expect(read.settlementAuthorisation).toBeNull();
    });

    it('a person’s authorisation names neither a service nor their key', async () => {
      const order = id('ORD');
      const held = await holdFor(order);
      await request(http)
        .post(`/v1/transactions/${held.id}/authorise-settlement`)
        .set('authorization', `Bearer ${admin(payer)}`)
        // The saga's key, sent by a person: still not the saga's command.
        .set('idempotency-key', `order:${order}:authorise`)
        .expect(200);
      await disputeThroughOrder(held.id, 'the invoice does not match the delivery');

      const read = await readAsPayer(held.id);
      expect(read.status).toBe('DISPUTED');
      expect(read.settlementAuthorisation).toMatchObject({ service: null, idempotencyKey: null });
    });
  });
});
