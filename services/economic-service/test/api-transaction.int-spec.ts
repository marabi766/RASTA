import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, auditor, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The transaction and settlement HTTP surface — every state transition the
 * lifecycle allows, and every one it refuses.
 *
 * The refusals carry as much weight as the successes here. `CREATED → SETTLED`
 * does not exist in the state machine, and neither does `DISPUTED → SETTLED`;
 * both are the product document's controls expressed as structure rather than
 * as a check somebody has to remember to write (docs/10 § 10.5). A test that
 * only walked the happy path would leave the platform's most consequential
 * property — that money cannot move without a confirmed receipt — asserted
 * nowhere above the domain layer.
 */
describe('transaction and settlement API', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('TXN-PAYER');
  const payee = apiTenant('TXN-PAYEE');
  const stranger = apiTenant('TXN-STRANGER');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asStranger = () => `Bearer ${admin(stranger)}`;
  const asPlatform = () => `Bearer ${admin(payer, ['UNION_ADMIN'])}`;

  /** Funds the payer's wallet through the real provider, never by an UPDATE. */
  async function fund(amountMinor: bigint): Promise<void> {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-txn-fund'))
      .send({ amountMinor: amountMinor.toString() })
      .expect(201);
  }

  // Returns the supertest `Test` rather than awaiting it, so each call site
  // states the status it expects instead of every one of them repeating the
  // same body.
  function createTransaction(body: Record<string, unknown>, token = asPayer()): request.Test {
    return request(http)
      .post('/v1/transactions')
      .set('authorization', token)
      .set('idempotency-key', id('api-txn'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        currency: 'IRR',
        holdFunds: false,
        ...body,
      });
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    await fund(200_000_000n);
    // The payee needs a wallet of its own before it can be paid into one.
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
    await request(http).get('/v1/wallets/me').set('authorization', asStranger()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, stranger]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  it('records an obligation without moving money', async () => {
    const response = await createTransaction({ grossAmountMinor: '1000' }).expect(201);

    expect(response.body.status).toBe('CREATED');
    expect(response.body.organizationId).toBe(payer);
    expect(response.body.counterpartyOrganizationId).toBe(payee);
    // Two legs — payer and payee — even before anything is settled.
    expect(response.body.legs.length).toBeGreaterThanOrEqual(2);
    expect(response.body.settlement).toBeNull();
  });

  it('holds the funds in the same transaction when asked to', async () => {
    const response = await createTransaction({
      grossAmountMinor: '25000',
      holdFunds: true,
    }).expect(201);

    expect(response.body.status).toBe('HELD');
  });

  it('refuses a hold with no payee, because nothing would ever release it', async () => {
    const response = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-txn-nopayee'))
      .send({ transactionType: 'LOGISTICS', grossAmountMinor: '500', holdFunds: true })
      .expect(422);

    expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refuses a transaction whose payer and payee are the same organization', async () => {
    const response = await createTransaction({
      grossAmountMinor: '500',
      counterpartyOrganizationId: payer,
    }).expect(422);

    expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refuses an unknown transaction type', async () => {
    const response = await createTransaction({
      grossAmountMinor: '500',
      transactionType: 'WALLET_TOP_UP',
    }).expect(400);

    // `WALLET_TOP_UP` is absent from the create schema on purpose: money
    // entering a wallet goes through the provider, and accepting it here would
    // let a caller conjure a credit with no payment behind it.
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an amount that is not a minor-unit string', async () => {
    const response = await createTransaction({ grossAmountMinor: 1000 }).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a hold larger than the available balance and leaves nothing behind', async () => {
    const reference = id('api-txn-overdraft');
    const response = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', reference)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '999999999999999',
        currency: 'IRR',
        sourceType: 'APITEST',
        sourceReference: reference,
        holdFunds: true,
      })
      .expect(422);

    expect(response.body.code).toBe('INSUFFICIENT_BALANCE');

    // The obligation and the hold are one transaction, so a refused hold takes
    // the obligation with it rather than leaving one nothing will release.
    const listed = await request(http)
      .get(`/v1/transactions?sourceReference=${encodeURIComponent(reference)}`)
      .set('authorization', asPayer())
      .expect(200);
    expect(listed.body.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  it('lists what this organization owes, and — on request — what it is owed', async () => {
    const outgoing = await request(http)
      .get('/v1/transactions?limit=5')
      .set('authorization', asPayer())
      .expect(200);
    expect(outgoing.body.items.length).toBeGreaterThan(0);
    expect(typeof outgoing.body.hasMore).toBe('boolean');
    for (const item of outgoing.body.items) expect(item.organizationId).toBe(payer);

    // The payee view crosses the tenant guard deliberately, narrowed to the
    // caller's own id — ANDing the guard's filter with a payee filter would ask
    // for a transaction whose payer and payee are the same organization, which
    // a CHECK constraint makes impossible, so it would always return nothing.
    const incoming = await request(http)
      .get('/v1/transactions?includeIncoming=true&limit=5')
      .set('authorization', asPayee())
      .expect(200);
    expect(incoming.body.items.length).toBeGreaterThan(0);
    for (const item of incoming.body.items) {
      expect([payee]).toContain(item.counterpartyOrganizationId);
    }

    // And without opting in, the payee's default view is what *it* owes.
    const payeeDefault = await request(http)
      .get('/v1/transactions?limit=5')
      .set('authorization', asPayee())
      .expect(200);
    for (const item of payeeDefault.body.items) expect(item.organizationId).toBe(payee);
  });

  it('filters by status and by type', async () => {
    const held = await request(http)
      .get('/v1/transactions?status=HELD&transactionType=MARKETPLACE_ORDER')
      .set('authorization', asPayer())
      .expect(200);

    for (const item of held.body.items) {
      expect(item.status).toBe('HELD');
      expect(item.transactionType).toBe('MARKETPLACE_ORDER');
    }
  });

  it('paginates with a cursor', async () => {
    const first = await request(http)
      .get('/v1/transactions?limit=1')
      .set('authorization', asPayer())
      .expect(200);
    expect(first.body.items).toHaveLength(1);

    if (first.body.nextCursor) {
      const second = await request(http)
        .get(`/v1/transactions?limit=1&cursor=${first.body.nextCursor}`)
        .set('authorization', asPayer())
        .expect(200);
      expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);
    }
  });

  it('shows a transaction to both named parties and to nobody else', async () => {
    const created = await createTransaction({ grossAmountMinor: '1200' }).expect(201);

    await request(http)
      .get(`/v1/transactions/${created.body.id}`)
      .set('authorization', asPayer())
      .expect(200);
    await request(http)
      .get(`/v1/transactions/${created.body.id}`)
      .set('authorization', asPayee())
      .expect(200);

    const refused = await request(http)
      .get(`/v1/transactions/${created.body.id}`)
      .set('authorization', asStranger())
      .expect(404);
    expect(refused.body.code).toBe('NOT_FOUND');
  });

  it('refuses the oversight role every transaction route', async () => {
    const token = `Bearer ${auditor(payer)}`;
    await request(http).get('/v1/transactions').set('authorization', token).expect(403);
    await request(http)
      .post('/v1/transactions')
      .set('authorization', token)
      .set('idempotency-key', id('api-auditor'))
      .send({ transactionType: 'LOGISTICS', grossAmountMinor: '1', holdFunds: false })
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // The lifecycle
  // -------------------------------------------------------------------------

  it('walks hold → authorise → settle, and refuses settlement before authorisation', async () => {
    const created = await createTransaction({
      grossAmountMinor: '30000',
      holdFunds: true,
    }).expect(201);
    const transactionId = created.body.id;

    const premature = await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-premature'))
      .send({ transactionId })
      .expect(409);
    expect(premature.body.code).toBe('INVALID_STATE_TRANSITION');

    const authorised = await request(http)
      .post(`/v1/transactions/${transactionId}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-authorise'))
      .expect(200);
    expect(authorised.body.status).toBe('PENDING_SETTLEMENT');

    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-settle'))
      .send({ transactionId })
      .expect(201);

    expect(BigInt(settled.body.grossAmountMinor)).toBe(30_000n);
    expect(BigInt(settled.body.netAmountMinor) + BigInt(settled.body.commissionAmountMinor)).toBe(
      30_000n,
    );
    // Zero because no rule is configured, which the response says out loud
    // rather than leaving to be inferred from a zero (docs/24 Q-08).
    expect(settled.body.commissionRuleMatched).toBe(false);

    const detail = await request(http)
      .get(`/v1/transactions/${transactionId}`)
      .set('authorization', asPayer())
      .expect(200);
    expect(detail.body.status).toBe('SETTLED');
    expect(detail.body.settlement.journalId).toBe(settled.body.journalId);

    // Settling twice is refused by the state machine, not merely discouraged.
    await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-settle-again'))
      .send({ transactionId })
      .expect(409);
  });

  it('stops settlement completely once an objection is registered', async () => {
    const created = await createTransaction({
      grossAmountMinor: '4000',
      holdFunds: true,
    }).expect(201);
    const transactionId = created.body.id;

    await request(http)
      .post(`/v1/transactions/${transactionId}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-disp-auth'))
      .expect(200);

    // A one-word reason is how a dispute becomes permanent by neglect, so the
    // schema demands a sentence.
    await request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-disp-short'))
      .send({ reason: 'no' })
      .expect(400);

    const disputed = await request(http)
      .post(`/v1/transactions/${transactionId}/dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-disp'))
      .send({ reason: 'The delivered quantity does not match the recorded obligation.' })
      .expect(200);
    expect(disputed.body.status).toBe('DISPUTED');

    await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-disp-settle'))
      .send({ transactionId })
      .expect(409);

    // Only a platform role resolves a dispute — an organization administrator
    // cannot lift its own objection back into the settlement queue.
    await request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-disp-resolve-denied'))
      .send({ resolution: 'The quantity was confirmed by the delivery note.' })
      .expect(403);

    const resolved = await request(http)
      .post(`/v1/transactions/${transactionId}/resolve-dispute`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('api-disp-resolve'))
      .send({ resolution: 'The quantity was confirmed by the delivery note.' })
      .expect(200);
    // Resolving unblocks; it does not pay. Releasing the money stays a
    // separate, deliberate act.
    expect(resolved.body.status).toBe('PENDING_SETTLEMENT');
  });

  it('refunds a held transaction to the payer', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    const before = BigInt(wallet.body.availableBalanceMinor);

    const created = await createTransaction({
      grossAmountMinor: '6000',
      holdFunds: true,
    }).expect(201);

    const refunded = await request(http)
      .post(`/v1/transactions/${created.body.id}/refund`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-txn-refund'))
      .send({ reason: 'the order was cancelled before dispatch' })
      .expect(200);
    expect(refunded.body.status).toBe('REFUNDED');

    const after = await request(http).get('/v1/wallets/me').set('authorization', asPayer());
    expect(BigInt(after.body.availableBalanceMinor)).toBe(before);
  });

  it('cancels an obligation nothing has moved against, and only that', async () => {
    const cancellable = await createTransaction({ grossAmountMinor: '800' }).expect(201);
    const cancelled = await request(http)
      .post(`/v1/transactions/${cancellable.body.id}/cancel`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-cancel'))
      .send({ reason: 'withdrawn' })
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // Once funds are held the correct act is a refund, which returns them
    // explicitly rather than leaving them in escrow behind a cancelled
    // obligation.
    const held = await createTransaction({
      grossAmountMinor: '900',
      holdFunds: true,
    }).expect(201);
    await request(http)
      .post(`/v1/transactions/${held.body.id}/cancel`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-cancel-held'))
      .send({ reason: 'withdrawn' })
      .expect(409);
  });

  it('refuses a party that is not the payer the right to commit it', async () => {
    const created = await createTransaction({ grossAmountMinor: '1500' }).expect(201);

    const response = await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asPayee())
      .set('idempotency-key', id('api-cross-authorise'))
      .expect(403);

    expect(response.body.code).toBe('TENANT_MISMATCH');
  });

  it('answers 404 for a transaction that does not exist', async () => {
    await request(http)
      .get('/v1/transactions/TXN_0000000000000000000000000')
      .set('authorization', asPayer())
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Settlement reads
  // -------------------------------------------------------------------------

  it('shows a settlement to the payer and to the payee, and to nobody else', async () => {
    const created = await createTransaction({
      grossAmountMinor: '2500',
      holdFunds: true,
    }).expect(201);

    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-view-auth'))
      .expect(200);

    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-view-settle'))
      .send({ transactionId: created.body.id })
      .expect(201);

    const settlementId = settled.body.settlementId;

    await request(http)
      .get(`/v1/settlements/${settlementId}`)
      .set('authorization', asPayer())
      .expect(200);
    await request(http)
      .get(`/v1/settlements/${settlementId}`)
      .set('authorization', asPayee())
      .expect(200);
    await request(http)
      .get(`/v1/settlements/${settlementId}`)
      .set('authorization', asStranger())
      .expect(404);

    const paid = await request(http)
      .get('/v1/settlements?limit=10')
      .set('authorization', asPayer())
      .expect(200);
    expect(paid.body.items.some((row: { id: string }) => row.id === settlementId)).toBe(true);

    const received = await request(http)
      .get('/v1/settlements?incoming=true&limit=10')
      .set('authorization', asPayee())
      .expect(200);
    expect(received.body.items.some((row: { id: string }) => row.id === settlementId)).toBe(true);
  });

  it('refuses a settlement for a transaction that does not exist', async () => {
    await request(http)
      .post('/v1/settlements')
      .set('authorization', asPayer())
      .set('idempotency-key', id('api-settle-missing'))
      .send({ transactionId: 'TXN_0000000000000000000000000' })
      .expect(404);
  });
});
