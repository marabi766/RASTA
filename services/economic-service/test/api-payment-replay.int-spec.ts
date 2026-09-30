import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A replayed top-up answers with the historical response; the current state
 * is read from the payment intent (PM ruling, round 2 on #143; docs/06 § 6.8).
 *
 * Same key, same response: the idempotency store does not re-check state,
 * by design. So a top-up that was captured, and whose refund has since been
 * left unfinished, still replays `CAPTURED` — and `GET
 * /v1/payment-intents/:id` is what says the refund is unresolved.
 */
describe('a replayed top-up and the intent behind it (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('REPLAY');
  const asOrg = () => `Bearer ${admin(org)}`;
  const asPlatform = () => `Bearer ${admin(org, ['UNION_ADMIN'])}`;

  /** A provider whose refund takes effect and whose answer is then lost. */
  class LosingRefundProvider extends MockPaymentProvider {
    loseNextRefund = false;

    override async refund(request: RefundRequest): Promise<RefundResult> {
      const answer = await super.refund(request);
      if (this.loseNextRefund) {
        this.loseNextRefund = false;
        throw new Error('provider response lost');
      }
      return answer;
    }
  }
  const provider = new LosingRefundProvider();

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: provider });
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  /** A top-up under `key`, which must answer 201 — first time or replayed. */
  async function topUp(key: string) {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asOrg())
      .expect(200);
    return request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', key)
      .send({ amountMinor: '4000' })
      .expect(201);
  }

  const intentOf = (paymentIntentId: string) =>
    request(http)
      .get(`/v1/payment-intents/${paymentIntentId}`)
      .set('authorization', asOrg())
      .expect(200);

  it('replays CAPTURED after a lost refund answer, while the intent reports REFUND_UNKNOWN', async () => {
    const key = id('replay-lost');
    const first = await topUp(key);
    expect(first.body).toMatchObject({ status: 'CAPTURED', simulated: true });

    provider.loseNextRefund = true;
    const refund = await request(http)
      .post(`/v1/payment-intents/${first.body.paymentIntentId}/refund`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('replay-lost-refund'))
      .send({ reason: 'the provider answer will be lost' });
    expect(refund.status).toBeGreaterThanOrEqual(500);

    // The historical response, byte for byte.
    const replay = await topUp(key);
    expect(replay.body).toEqual(first.body);

    // The current state.
    const intent = await intentOf(first.body.paymentIntentId);
    expect(intent.body).toMatchObject({
      id: first.body.paymentIntentId,
      status: 'CAPTURED',
      failureReason: 'REFUND_UNKNOWN',
    });
  });

  it.each(['REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING', 'REFUND_REQUESTED'])(
    'replays CAPTURED while the intent reports %s',
    async (marker) => {
      // Each marker is produced for real in payment-unknown-outcome.int-spec.ts;
      // here it is written directly so only the read path is under test.
      const key = id(`replay-${marker.toLowerCase()}`);
      const first = await topUp(key);
      await runUnscoped('the suite marks the intent', () =>
        harness.prisma.client.paymentIntent.update({
          where: { id: first.body.paymentIntentId },
          data: { failureReason: marker },
        }),
      );

      const replay = await topUp(key);
      expect(replay.body).toEqual(first.body);
      expect((await intentOf(first.body.paymentIntentId)).body).toMatchObject({
        status: 'CAPTURED',
        failureReason: marker,
      });
    },
  );
});
