import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { SAGA_DISPUTE_RECOVERY } from '@rasta/testing';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * economic-service's half of `SAGA_DISPUTE_RECOVERY` (@rasta/testing): what the
 * order saga gets when it retries a dispute resolution after this service let
 * the stored answer expire (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`; D-053, D-060,
 * Codex on #322).
 *
 * The first attempt resolved the dispute and its answer never reached the
 * saga. The retry is judged against PENDING_SETTLEMENT and refused for it;
 * the saga then reads the transaction as its payer and looks for this
 * resolution's words. Keeping the objection in `disputeReason` moved those
 * words to `disputeResolution` — so the answers here, for a transaction
 * resolved now and for one resolved before the field, are pinned to the
 * fixture marketplace-service's recovery is tested against
 * (`saga-dispute-recovery.int-spec.ts` there). Calls are made as
 * `EconomicClient` makes them: a marketplace-service token signed for the
 * buyer, and the saga's keys.
 */
describe('a saga dispute resolution retried after its stored answer expired', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('RTTL-PAYER');
  const payee = apiTenant('RTTL-PAYEE');
  const asSaga = () => internalToken('marketplace-service', { organizationId: payer });
  const { reason, resolution, refusedRetry, readAfter } = SAGA_DISPUTE_RECOVERY;

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
      .set('idempotency-key', id('rttl-fund'))
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

  /** An order's obligation, held, disputed and resolved by the saga. */
  async function resolvedBySaga(): Promise<{ transactionId: string; resolve: () => request.Test }> {
    const order = `ORD_${ulid()}`;
    const dispute = `DSP_${ulid()}`;
    const token = await asSaga();
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
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
    const transactionId = created.body.id as string;

    await request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('x-internal-token', token)
      .set('idempotency-key', `order:${order}:dispute:${dispute}`)
      .send({ reason })
      .expect(200);

    const resolve = () =>
      request(http)
        .post(`/v1/transactions/${transactionId}/resolve-dispute`)
        .set('x-internal-token', token)
        .set('idempotency-key', `order:${order}:resolve-dispute:${dispute}`)
        .send({ resolution });
    await resolve().expect(200);
    return { transactionId, resolve };
  }

  /** `GET /v1/transactions/{id}` as the payer, with the saga's token. */
  const readAsPayer = async (transactionId: string) =>
    (
      await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('x-internal-token', await asSaga())
        .expect(200)
    ).body as Record<string, unknown>;

  it('resolved now: refused for its own effect, and the payer reads the resolution beside the reason', async () => {
    const { transactionId, resolve } = await resolvedBySaga();

    await expireAnswers();
    const retried = await resolve();
    expect({ status: retried.status, code: retried.body.code }).toEqual(refusedRetry);

    const read = await readAsPayer(transactionId);
    expect(read).toMatchObject(readAfter.resolvedNow);
    expect(typeof read.disputedAt).toBe('string');
    // The reason is not the resolution: reading it for the resolution's
    // words, as the saga did, finds nothing.
    expect(read.disputeReason).not.toBe(resolution);
  });

  it('resolved before the field: refused alike, and the payer reads the resolution where it was written', async () => {
    const { transactionId, resolve } = await resolvedBySaga();
    // What a resolution before migration 20261016160000 left: its words over
    // the objection, and no column of their own.
    await runUnscoped('the suite models a transaction resolved before D-060', () =>
      harness.prisma.client.transaction.update({
        where: { id: transactionId },
        data: { disputeReason: resolution, disputeResolution: null },
      }),
    );

    await expireAnswers();
    const retried = await resolve();
    expect({ status: retried.status, code: retried.body.code }).toEqual(refusedRetry);

    const read = await readAsPayer(transactionId);
    expect(read).toMatchObject(readAfter.resolvedBeforeTheField);
    expect(typeof read.disputedAt).toBe('string');
  });
});
