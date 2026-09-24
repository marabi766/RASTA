import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * One idempotency key, reused on a second resource (docs/06 § 6.8).
 *
 * Keys are stored under the route *template*, and these routes used to hash
 * only their DTO. So key K with the same body, sent for a second transaction,
 * looked exactly like a retry of the first: the first response was replayed,
 * the caller was told the second one had been refunded or cancelled, and
 * nothing had happened to it at all.
 *
 * Every case here asserts both halves: the reuse is refused as
 * `409 IDEMPOTENCY_KEY_REUSED`, and the second resource is exactly as it was.
 * A genuine retry on the first resource still replays.
 */
describe('idempotency key reuse across resources', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('IDT-PAYER');
  const payee = apiTenant('IDT-PAYEE');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asPlatformInPayer = () => `Bearer ${admin(payer, ['UNION_ADMIN'])}`;

  async function transaction(holdFunds: boolean): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('idt-create'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '1500',
        currency: 'IRR',
        holdFunds,
      })
      .expect(201);
    return created.body.id as string;
  }

  async function statusOf(transactionId: string): Promise<string> {
    const read = await request(http)
      .get(`/v1/transactions/${transactionId}`)
      .set('authorization', asPayer())
      .expect(200);
    return read.body.status as string;
  }

  /**
   * K on `first` succeeds; K again on `first` replays; K on `second` is 409
   * and leaves `second` in `expectedSecondStatus`.
   */
  async function expectKeyBoundToTarget(
    route: (target: string) => string,
    authorization: string,
    body: Record<string, unknown>,
    first: string,
    second: string,
    successStatus: number,
  ): Promise<{ firstBody: Record<string, unknown> }> {
    const key = id('idt-shared-key');

    const done = await request(http)
      .post(route(first))
      .set('authorization', authorization)
      .set('idempotency-key', key)
      .send(body)
      .expect(successStatus);

    const replay = await request(http)
      .post(route(first))
      .set('authorization', authorization)
      .set('idempotency-key', key)
      .send(body)
      .expect(successStatus);
    expect(replay.body).toEqual(done.body);

    const reused = await request(http)
      .post(route(second))
      .set('authorization', authorization)
      .set('idempotency-key', key)
      .send(body)
      .expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    return { firstBody: done.body };
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('idt-fund'))
      .send({ amountMinor: '100000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  it('cancel: the second transaction is refused, not reported cancelled', async () => {
    const [a, b] = [await transaction(false), await transaction(false)];
    await expectKeyBoundToTarget(
      (t) => `/v1/transactions/${t}/cancel`,
      asPayer(),
      { reason: 'withdrawn before anything moved' },
      a,
      b,
      200,
    );
    expect(await statusOf(a)).toBe('CANCELLED');
    expect(await statusOf(b)).toBe('CREATED');
  });

  it('dispute: the second transaction is refused, and settlement is not halted on it', async () => {
    const [a, b] = [await transaction(true), await transaction(true)];
    await expectKeyBoundToTarget(
      (t) => `/v1/transactions/${t}/dispute`,
      asPayer(),
      { reason: 'The delivered quantity does not match the order.' },
      a,
      b,
      200,
    );
    expect(await statusOf(a)).toBe('DISPUTED');
    expect(await statusOf(b)).toBe('HELD');
  });

  it('refund: the second transaction keeps its escrow', async () => {
    const [a, b] = [await transaction(true), await transaction(true)];
    await expectKeyBoundToTarget(
      (t) => `/v1/transactions/${t}/refund`,
      asPayee(),
      { reason: 'returned by the payee' },
      a,
      b,
      200,
    );
    expect(await statusOf(a)).toBe('REFUNDED');
    expect(await statusOf(b)).toBe('HELD');
  });

  it('payment-intent refund: the second top-up is not reversed', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    const topUp = async () =>
      (
        await request(http)
          .post(`/v1/wallets/${wallet.body.id}/top-up`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('idt-topup'))
          .send({ amountMinor: '2500' })
          .expect(201)
      ).body.paymentIntentId as string;
    const [a, b] = [await topUp(), await topUp()];

    await expectKeyBoundToTarget(
      (t) => `/v1/payment-intents/${t}/refund`,
      asPlatformInPayer(),
      { reason: 'refunded by a platform administrator' },
      a,
      b,
      200,
    );

    const second = await request(http)
      .get(`/v1/payment-intents/${b}`)
      .set('authorization', asPayer())
      .expect(200);
    expect(second.body.status).not.toBe('REFUNDED');
  });
});
