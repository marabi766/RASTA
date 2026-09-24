import request from 'supertest';
import type { Server } from 'node:http';
import {
  admin,
  apiTenant,
  internalToken,
  platformAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * Who may refund a transaction, over the real HTTP stack (docs/24 Q-62).
 *
 * The defect this suite pins: `refund` checked only that the caller could
 * *see* the transaction, and the payer can. So a payer's own administrator
 * could confirm receipt, or open a dispute, and then take its escrow back —
 * stepping around `resolve-dispute`, which is a platform decision, and leaving
 * the payee unpaid (docs/10 § 10.5).
 *
 * Every refusal is asserted twice: by its status code, and by the transaction
 * and the payer's balance being exactly what they were before the attempt. A
 * 403 that had already moved the money would be worse than no check at all.
 */
describe('refund authority (actor × state), dispute and tenant isolation', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('RFD-PAYER');
  const payee = apiTenant('RFD-PAYEE');
  const stranger = apiTenant('RFD-STRANGER');

  const asPayerAdmin = () => `Bearer ${admin(payer)}`;
  const asPayerPlatformRole = () => `Bearer ${admin(payer, ['UNION_ADMIN'])}`;
  const asPayeeAdmin = () => `Bearer ${admin(payee)}`;
  const asPayeeOperator = () => `Bearer ${admin(payee, ['OPERATOR'])}`;
  const asStranger = () => `Bearer ${admin(stranger)}`;
  const asPlatform = () => `Bearer ${platformAdmin()}`;

  type State = 'HELD' | 'PENDING_SETTLEMENT' | 'DISPUTED';

  async function walletOf(token: string): Promise<{ id: string; available: bigint }> {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', token)
      .expect(200);
    return { id: wallet.body.id, available: BigInt(wallet.body.availableBalanceMinor) };
  }

  /** A held transaction, moved on to `state` the way a payer really would. */
  async function transactionIn(state: State): Promise<string> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayerAdmin())
      .set('idempotency-key', id('rfd-create'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '4000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    const transactionId = created.body.id as string;

    if (state === 'PENDING_SETTLEMENT') {
      await request(http)
        .post(`/v1/transactions/${transactionId}/authorise-settlement`)
        .set('authorization', asPayerAdmin())
        .set('idempotency-key', id('rfd-authorise'))
        .expect(200);
    }
    if (state === 'DISPUTED') {
      await request(http)
        .post(`/v1/transactions/${transactionId}/dispute`)
        .set('authorization', asPayerAdmin())
        .set('idempotency-key', id('rfd-dispute'))
        .send({ reason: 'The delivered quantity does not match the order.' })
        .expect(200);
    }
    return transactionId;
  }

  function refund(transactionId: string, authorization: { header: string; value: string }) {
    return request(http)
      .post(`/v1/transactions/${transactionId}/refund`)
      .set(authorization.header, authorization.value)
      .set('idempotency-key', id('rfd-refund'))
      .send({ reason: 'Returned in the refund-authority suite.' });
  }

  const user = (token: string) => ({ header: 'authorization', value: token });
  const service = async (organizationId: string) => ({
    header: 'x-internal-token',
    value: await internalToken('marketplace-service', { organizationId }),
  });

  async function statusOf(transactionId: string): Promise<string> {
    const read = await request(http)
      .get(`/v1/transactions/${transactionId}`)
      .set('authorization', asPayerAdmin())
      .expect(200);
    return read.body.status as string;
  }

  /** Refused, and nothing moved: same status, same payer balance. */
  async function expectRefused(
    state: State,
    caller: { header: string; value: string },
    expectedStatus: 403 | 404,
    expectedCode = expectedStatus === 404 ? 'NOT_FOUND' : 'FORBIDDEN',
  ): Promise<void> {
    const transactionId = await transactionIn(state);
    const before = await walletOf(asPayerAdmin());

    const response = await refund(transactionId, caller).expect(expectedStatus);
    expect(response.body.code).toBe(expectedCode);

    expect(await statusOf(transactionId)).toBe(state);
    expect((await walletOf(asPayerAdmin())).available).toBe(before.available);
  }

  /** Refunded, and the escrow is back with the payer. */
  async function expectRefunded(state: State, caller: { header: string; value: string }) {
    const transactionId = await transactionIn(state);
    const before = await walletOf(asPayerAdmin());

    const response = await refund(transactionId, caller).expect(200);
    expect(response.body.status).toBe('REFUNDED');

    expect(await statusOf(transactionId)).toBe('REFUNDED');
    expect((await walletOf(asPayerAdmin())).available).toBe(before.available + 4000n);
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await walletOf(asPayerAdmin());
    await request(http)
      .post(`/v1/wallets/${wallet.id}/top-up`)
      .set('authorization', asPayerAdmin())
      .set('idempotency-key', id('rfd-fund'))
      .send({ amountMinor: '1000000' })
      .expect(201);
    // The payee and the stranger need wallets for the reads above to mean
    // anything; neither is funded.
    await walletOf(asPayeeAdmin());
    await walletOf(asStranger());
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, stranger]);
    await harness.close();
  });

  describe.each<State>(['HELD', 'PENDING_SETTLEMENT', 'DISPUTED'])('from %s', (state) => {
    it('refuses the payer’s own administrator — 403, nothing moves', async () => {
      await expectRefused(state, user(asPayerAdmin()), 403);
    });

    it('refuses the payer even when its administrator holds a platform role', async () => {
      await expectRefused(state, user(asPayerPlatformRole()), 403);
    });

    it('refuses a payee member with no financial role — 403', async () => {
      // Refused before the domain check, by the route's own `@Roles`.
      await expectRefused(state, user(asPayeeOperator()), 403, 'INSUFFICIENT_ROLE');
    });

    it('hides the transaction from a stranger organization — tenant isolation, 404', async () => {
      await expectRefused(state, user(asStranger()), 404);
    });

    it('hides it from a marketplace token signed for a non-party — tenant isolation, 404', async () => {
      await expectRefused(state, await service(stranger), 404);
    });

    it('refunds for a platform administrator acting for another organization', async () => {
      await expectRefunded(state, user(asPlatform()));
    });

    it('refunds for the order saga, whose token is signed for the payer', async () => {
      await expectRefunded(state, await service(payer));
    });
  });

  describe.each<State>(['HELD', 'PENDING_SETTLEMENT'])('from %s', (state) => {
    it('refunds for the payee’s administrator — a voluntary return', async () => {
      await expectRefunded(state, user(asPayeeAdmin()));
    });
  });

  it('refuses the payee’s administrator once the transaction is under dispute — 403', async () => {
    await expectRefused('DISPUTED', user(asPayeeAdmin()), 403);
  });
});
