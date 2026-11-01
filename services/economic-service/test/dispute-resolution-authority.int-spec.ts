import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A resolved dispute returns a transaction to where its settlement authority
 * stands, never further (marketplace audit F1, PM decision D-083).
 *
 * The order saga disputes an order's obligation whenever the order is
 * disputed — before the buyer confirmed receipt too, when the obligation is
 * HELD and nothing has authorised its settlement. A resolution used to send
 * every dispute to PENDING_SETTLEMENT, so an operator's "carry on" made the
 * obligation settlement-ready with no receipt behind it. Now it goes back to
 * HELD, and only the authorisation the saga sends after the buyer's receipt
 * makes it settleable.
 *
 * Every assertion about money is read from the rows economic-service keeps —
 * the transaction, its wallet hold, its journals, its settlement and the
 * payer's wallet — never from what a client was answered. The calls are the
 * saga's, made as `EconomicClient` makes them: a marketplace-service token
 * signed for the buyer, and the order's keys.
 */
describe('a resolved dispute returns a transaction to where its settlement authority stands (D-083)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('DRA-PAYER');
  const payee = apiTenant('DRA-PAYEE');
  const platform = apiTenant('DRA-PLATFORM');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asSystemAdmin = () => `Bearer ${admin(platform, ['SYSTEM_ADMIN'])}`;
  const saga = () => internalToken('marketplace-service', { organizationId: payer });

  const AMOUNT = 7000n;
  const FUNDED = 50_000_000n;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('dra-fund'))
      .send({ amountMinor: FUNDED.toString() })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, platform]);
    await harness.close();
  });

  /** An order's obligation, recorded and held by the saga as `createObligation` does. */
  async function heldOrder(): Promise<{ orderId: string; transactionId: string }> {
    const orderId = `ORD_${ulid()}`;
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await saga())
      .set('idempotency-key', `order:${orderId}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT.toString(),
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: orderId,
        holdFunds: true,
      })
      .expect(201);
    expect(created.body.status).toBe('HELD');
    return { orderId, transactionId: created.body.id as string };
  }

  const sagaCall = async (path: string, key: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(path)
      .set('x-internal-token', await saga())
      .set('idempotency-key', key)
      .send(body);

  /** The saga mirrors dispute `disputeId` and then its operator's SETTLE decision. */
  async function disputeAndResolve(orderId: string, transactionId: string): Promise<string> {
    const disputeId = `DSP_${ulid()}`;
    const disputed = await sagaCall(
      `/v1/transactions/${transactionId}/dispute`,
      `order:${orderId}:dispute:${disputeId}`,
      { reason: 'The buyer says the parts are the wrong model.' },
    );
    expect(disputed.status).toBe(200);
    expect(disputed.body.status).toBe('DISPUTED');
    const economicDisputeId = disputed.body.disputeId as string;

    const resolved = await sagaCall(
      `/v1/transactions/${transactionId}/resolve-dispute`,
      `order:${orderId}:resolve-dispute:${disputeId}`,
      { resolution: 'Dispute resolved: SETTLE', disputeId: economicDisputeId },
    );
    expect(resolved.status).toBe(200);
    return resolved.body.status as string;
  }

  /** What economic-service holds about one transaction's money. */
  async function moneyOf(transactionId: string) {
    return runUnscoped('the suite reads the rows that record the money', async () => {
      const client = harness.prisma.client;
      const transaction = await client.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { status: true, settlementAuthorisedAt: true },
      });
      const holds = await client.walletHold.findMany({
        where: { reference: transactionId, referenceType: 'TRANSACTION' },
        select: { status: true, amountMinor: true },
      });
      const journals = await client.journal.findMany({
        where: { transactionId },
        select: { journalType: true },
        orderBy: { createdAt: 'asc' },
      });
      const settlements = await client.settlement.count({ where: { transactionId } });
      const wallet = await client.wallet.findFirstOrThrow({
        where: { organizationId: payer, currency: 'IRR' },
        select: { availableBalanceMinor: true, ledgerBalanceMinor: true },
      });
      return {
        status: transaction.status,
        authorised: transaction.settlementAuthorisedAt !== null,
        holds: holds.map((hold) => [hold.status, hold.amountMinor]),
        journals: journals.map((journal) => journal.journalType).sort(),
        settlements,
        wallet,
      };
    });
  }

  it('a dispute raised while HELD comes back HELD, cycle after cycle, with the escrow untouched', async () => {
    const { orderId, transactionId } = await heldOrder();
    const held = await moneyOf(transactionId);
    expect(held).toMatchObject({
      status: 'HELD',
      authorised: false,
      holds: [['ACTIVE', AMOUNT]],
      journals: ['FUNDS_HELD'],
      settlements: 0,
    });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      expect(await disputeAndResolve(orderId, transactionId)).toBe('HELD');
      // Nothing moved: the same hold, the same journals, the same balances.
      expect(await moneyOf(transactionId)).toEqual(held);
    }

    // Settlement is refused until something authorises it — the resolution
    // did not.
    const early = await sagaCall('/v1/settlements', `order:${orderId}:settle`, { transactionId });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(await moneyOf(transactionId)).toEqual(held);
  });

  it('after the receipt’s authorisation it settles exactly once', async () => {
    const { orderId, transactionId } = await heldOrder();
    expect(await disputeAndResolve(orderId, transactionId)).toBe('HELD');
    expect(await disputeAndResolve(orderId, transactionId)).toBe('HELD');

    const authorised = await sagaCall(
      `/v1/transactions/${transactionId}/authorise-settlement`,
      `order:${orderId}:authorise`,
    );
    expect(authorised.status).toBe(200);
    expect(authorised.body.status).toBe('PENDING_SETTLEMENT');

    const settled = await sagaCall('/v1/settlements', `order:${orderId}:settle`, { transactionId });
    expect(settled.status).toBe(201);
    // A replay of the same key, and a fresh key: one settlement, either way.
    await sagaCall('/v1/settlements', `order:${orderId}:settle`, { transactionId });
    const second = await sagaCall('/v1/settlements', id('dra-settle-again'), { transactionId });
    expect(second.status).toBe(409);

    expect(await moneyOf(transactionId)).toMatchObject({
      status: 'SETTLED',
      authorised: true,
      holds: [['RELEASED', AMOUNT]],
      journals: ['FUNDS_HELD', 'SETTLEMENT'],
      settlements: 1,
    });
  });

  it('a refund after a resumed dispute returns the escrow exactly once', async () => {
    const before = (await moneyOf((await heldOrder()).transactionId)).wallet;
    const { orderId, transactionId } = await heldOrder();
    expect(await disputeAndResolve(orderId, transactionId)).toBe('HELD');
    expect(await disputeAndResolve(orderId, transactionId)).toBe('HELD');

    const refunded = await sagaCall(
      `/v1/transactions/${transactionId}/refund`,
      `order:${orderId}:refund`,
      { reason: 'The buyer cancelled after the dispute was settled back.' },
    );
    expect(refunded.status).toBe(200);
    // The saga's retry replays; anyone's fresh refund is refused.
    await sagaCall(`/v1/transactions/${transactionId}/refund`, `order:${orderId}:refund`, {
      reason: 'The buyer cancelled after the dispute was settled back.',
    });
    const again = await request(http)
      .post(`/v1/transactions/${transactionId}/refund`)
      .set('authorization', asSystemAdmin())
      .set('idempotency-key', id('dra-refund-again'))
      .send({ reason: 'A second refund that must not happen.' });
    expect(again.status).toBe(409);

    const after = await moneyOf(transactionId);
    expect(after).toMatchObject({
      status: 'REFUNDED',
      authorised: false,
      holds: [['REFUNDED', AMOUNT]],
      journals: ['FUNDS_HELD', 'FUNDS_REFUNDED'],
      settlements: 0,
    });
    // The first order's hold is still out; this one's came back, once.
    expect(after.wallet.availableBalanceMinor).toBe(before.availableBalanceMinor);
    expect(after.wallet.ledgerBalanceMinor).toBe(before.ledgerBalanceMinor);
  });

  it('a dispute raised after the authorisation comes back to the settlement queue, as before', async () => {
    const { orderId, transactionId } = await heldOrder();
    expect(
      (
        await sagaCall(
          `/v1/transactions/${transactionId}/authorise-settlement`,
          `order:${orderId}:authorise`,
        )
      ).status,
    ).toBe(200);
    expect(await disputeAndResolve(orderId, transactionId)).toBe('PENDING_SETTLEMENT');
    expect(await moneyOf(transactionId)).toMatchObject({
      status: 'PENDING_SETTLEMENT',
      authorised: true,
      holds: [['ACTIVE', AMOUNT]],
      settlements: 0,
    });
  });

  it('an obligation with no escrow, authorised when recorded, comes back to the settlement queue', async () => {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('dra-unheld'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '5000',
        currency: 'IRR',
      })
      .expect(201);
    const transactionId = created.body.id as string;
    await request(http)
      .post(`/v1/transactions/${transactionId}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('dra-unheld-auth'))
      .expect(200);
    await request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('dra-unheld-dispute'))
      .send({ reason: 'The invoice names another supplier.' })
      .expect(200);
    const resolved = await request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set('authorization', asSystemAdmin())
      .set('idempotency-key', id('dra-unheld-resolve'))
      .send({ resolution: 'The supplier on the invoice is the right one.' })
      .expect(200);
    expect(resolved.body.status).toBe('PENDING_SETTLEMENT');
    expect(await moneyOf(transactionId)).toMatchObject({ holds: [], settlements: 0 });
  });
});
