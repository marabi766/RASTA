import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { mockReferenceWithDirective } from '../src/payment/mock.provider';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The last of the refusals, and the defaults that stand in when a caller says
 * nothing.
 *
 * Two kinds of decision live here, and both are easy to get wrong in a way
 * nothing else notices:
 *
 *  - **A default.** An obligation with no counterparty and no stated currency
 *    is a legitimate thing to record — a fee, an adjustment — and the platform
 *    must fill in the currency rather than leave it null, because a ledger
 *    entry with no currency cannot be summed with anything.
 *
 *  - **A refusal with the right shape.** A provider that declines without
 *    naming a reason still has to produce a code, because "FAILED" with an
 *    empty reason tells an operator nothing and tells a client less.
 */
describe('refusals and defaults', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('REF-A');
  const other = apiTenant('REF-B');

  const asOrg = () => `Bearer ${admin(org)}`;
  const asOther = () => `Bearer ${admin(other)}`;
  const asPlatform = () => `Bearer ${admin(org, ['UNION_ADMIN'])}`;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-fund'))
      .send({ amountMinor: '20000000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asOther()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, other]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  it('records an obligation with no counterparty, and supplies the currency', async () => {
    const response = await request(http)
      .post('/v1/transactions')
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-no-payee'))
      .send({
        transactionType: 'LOGISTICS',
        grossAmountMinor: '3400',
        // No `counterpartyOrganizationId`, and no `currency`.
        holdFunds: false,
      })
      .expect(201);

    expect(response.body.counterpartyOrganizationId).toBeNull();
    // Filled in rather than left null: a ledger entry with no currency cannot
    // be summed with anything, and the trial balance is per-currency.
    expect(response.body.currency).toBe('IRR');
    // One leg, because there is only one party. The payee leg is not
    // fabricated with the payer's own id to keep the shape symmetrical.
    expect(response.body.legs).toHaveLength(1);
    expect(response.body.legs[0].role).toBe('PAYER');
  });

  it('cannot be settled, because there is nobody to pay', async () => {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-unsettleable'))
      .send({ transactionType: 'LOGISTICS', grossAmountMinor: '2200', holdFunds: false })
      .expect(201);

    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-unsettleable-auth'))
      .expect(200);

    const response = await request(http)
      .post('/v1/settlements')
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-unsettleable-settle'))
      .send({ transactionId: created.body.id })
      .expect(422);

    // Refused at the settlement rather than at the obligation: recording what
    // is owed and deciding who receives it are different moments, and an
    // adjustment may legitimately never have a payee at all.
    expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('refuses a top-up onto a wallet the caller does not own', async () => {
    const mine = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

    const response = await request(http)
      .post(`/v1/wallets/${mine.body.id}/top-up`)
      .set('authorization', asOther())
      .set('idempotency-key', id('ref-foreign-topup'))
      .send({ amountMinor: '1000' })
      .expect(404);

    // 404, not 403 — funding somebody else's wallet must not confirm that the
    // wallet exists.
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('names a code when the provider declines without giving one', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-bare-fail'))
      .send({ amountMinor: '5000', instrument: 'fail:' })
      .expect(201);

    expect(response.body.status).toBe('FAILED');
    // "FAILED" with an empty reason tells an operator nothing and a client
    // less, so a bare refusal still produces a code.
    expect(response.body.failureReason).toBeTruthy();
    expect(response.body.failureReason).toContain('PROVIDER_DECLINED');
  });

  it('names a code when the capture declines without giving one', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

    const response = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-bare-capture-fail'))
      .send({ amountMinor: '5000', instrument: 'fail-capture:' })
      .expect(201);

    expect(response.body.status).toBe('FAILED');
    expect(response.body.failureReason).toBeTruthy();
  });

  it('refuses a refund the provider itself refuses, and moves nothing', async () => {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

    const topUp = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-refund-declined'))
      .send({ amountMinor: '8000' })
      .expect(201);
    expect(topUp.body.status).toBe('CAPTURED');

    // The refund directive rides on the **provider reference**, not on the
    // instrument: `refund` is called with the reference the authorisation
    // issued, exactly as a real provider's would be. `mockReferenceWithDirective`
    // is exported for this, so the encoding is not restated here as a literal
    // that could drift from the provider's own.
    await runUnscoped('the suite arms a refund failure on the intent it created', () =>
      harness.prisma.client.paymentIntent.update({
        where: { id: topUp.body.paymentIntentId },
        data: {
          providerReference: mockReferenceWithDirective(
            topUp.body.paymentIntentId,
            'fail-refund:PROVIDER_UNAVAILABLE',
          ),
        },
      }),
    );

    const before = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

    const response = await request(http)
      .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
      .set('authorization', asPlatform())
      .set('idempotency-key', id('ref-refund-declined-attempt'))
      .send({ reason: 'the provider will decline this one' })
      .expect(422);

    expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');

    // The reversal is posted only after the provider agrees. Posting it first
    // and compensating on failure would be this platform moving money to
    // repair a failure it has not diagnosed (docs/08 § 8.6).
    const after = await request(http).get('/v1/wallets/me').set('authorization', asOrg());
    expect(after.body.ledgerBalanceMinor).toBe(before.body.ledgerBalanceMinor);

    const intent = await request(http)
      .get(`/v1/payment-intents/${topUp.body.paymentIntentId}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(intent.body.status).toBe('CAPTURED');
  });

  it('answers 404 for a settlement, refund or cancellation of a transaction that is not there', async () => {
    const missing = 'TXN_0000000000000000000000001';

    await request(http)
      .post('/v1/settlements')
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-missing-settle'))
      .send({ transactionId: missing })
      .expect(404);

    await request(http)
      .post(`/v1/transactions/${missing}/refund`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-missing-refund'))
      .send({ reason: 'a transaction that does not exist' })
      .expect(404);

    await request(http)
      .post(`/v1/transactions/${missing}/cancel`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('ref-missing-cancel'))
      .send({ reason: 'likewise' })
      .expect(404);
  });

  it('pages an account statement to its last page without offering a cursor past the end', async () => {
    const accounts = await request(http)
      .get('/v1/ledger/accounts')
      .set('authorization', asOrg())
      .expect(200);
    const wallet = accounts.body.items.find(
      (account: { purpose: string }) => account.purpose === 'WALLET',
    );

    const all = await request(http)
      .get(`/v1/ledger/accounts/${wallet.id}/entries?limit=200`)
      .set('authorization', asOrg())
      .expect(200);

    // The last page says so rather than handing back a cursor that returns
    // nothing: a client that keeps following a non-null cursor never stops.
    expect(all.body.hasMore).toBe(false);
    expect(all.body.nextCursor).toBeNull();
  });

  it('keeps a settlement list paging over more than one page', async () => {
    const settlements: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await request(http)
        .post('/v1/transactions')
        .set('authorization', asOrg())
        .set('idempotency-key', id(`ref-page-${index}`))
        .send({
          transactionType: 'MAINTENANCE_SERVICE',
          counterpartyOrganizationId: other,
          grossAmountMinor: '1100',
          currency: 'IRR',
          holdFunds: true,
        })
        .expect(201);

      await request(http)
        .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
        .set('authorization', asOrg())
        .set('idempotency-key', id(`ref-page-auth-${index}`))
        .expect(200);

      const settled = await request(http)
        .post('/v1/settlements')
        .set('authorization', asOrg())
        .set('idempotency-key', id(`ref-page-settle-${index}`))
        .send({ transactionId: created.body.id })
        .expect(201);
      settlements.push(settled.body.settlementId);
    }

    const first = await request(http)
      .get('/v1/settlements?limit=1')
      .set('authorization', asOrg())
      .expect(200);
    expect(first.body.items).toHaveLength(1);

    const second = await request(http)
      .get(`/v1/settlements?limit=1&cursor=${first.body.items[0].id}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);

    // Both are the caller's own, whichever page they arrive on.
    const seen = await runUnscoped('the suite verifies the settlements it created', () =>
      harness.prisma.client.settlement.findMany({
        where: { id: { in: settlements } },
        select: { organizationId: true },
      }),
    );
    for (const row of seen) expect(row.organizationId).toBe(org);
  });
  // -------------------------------------------------------------------------
  // Paging and windows
  // -------------------------------------------------------------------------

  it('pages the commissions and the payment intents it produced', async () => {
    const commissions = await request(http)
      .get('/v1/commissions?limit=1')
      .set('authorization', asOther())
      .expect(200);

    if (commissions.body.nextCursor) {
      const next = await request(http)
        .get(`/v1/commissions?limit=1&cursor=${commissions.body.nextCursor}`)
        .set('authorization', asOther())
        .expect(200);
      expect(next.body.items[0]?.id).not.toBe(commissions.body.items[0].id);
    }

    const intents = await request(http)
      .get('/v1/payment-intents?limit=1')
      .set('authorization', asOrg())
      .expect(200);
    expect(intents.body.items).toHaveLength(1);

    const nextIntents = await request(http)
      .get(`/v1/payment-intents?limit=1&cursor=${intents.body.items[0].id}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(nextIntents.body.items[0]?.id).not.toBe(intents.body.items[0].id);
  });

  it('accepts one end of an occurred-at window without the other', async () => {
    // Both bounds are optional and independent. "everything since the first of
    // the month" and "everything up to the audit date" are both ordinary
    // questions, and requiring the pair would make each of them awkward.
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const fromOnly = await request(http)
      .get(`/v1/transactions?from=${past}&limit=2`)
      .set('authorization', asOrg())
      .expect(200);
    expect(fromOnly.body.items.length).toBeGreaterThan(0);

    const toOnly = await request(http)
      .get(`/v1/transactions?to=${future}&limit=2`)
      .set('authorization', asOrg())
      .expect(200);
    expect(toOnly.body.items.length).toBeGreaterThan(0);

    // A page that has more offers a cursor; the caller can follow it.
    if (toOnly.body.hasMore) {
      expect(toOnly.body.nextCursor).toBeTruthy();
      const next = await request(http)
        .get(`/v1/transactions?to=${future}&limit=2&cursor=${toOnly.body.nextCursor}`)
        .set('authorization', asOrg())
        .expect(200);
      const seen = new Set(toOnly.body.items.map((row: { id: string }) => row.id));
      for (const row of next.body.items) expect(seen.has(row.id)).toBe(false);
    }
  });

  it('serves a reward standing once the subject has one', async () => {
    // `balance` is null until something has been granted, and an object
    // afterwards. Both shapes are served by the same endpoint, so both need to
    // be asserted — a client that only ever saw one of them would break on the
    // other.
    const token = admin(org, ['SYSTEM_ADMIN']);
    await request(http)
      .post('/v1/rewards/rules')
      .set('authorization', `Bearer ${token}`)
      .send({
        organizationId: org,
        triggerEvent: 'MAINTENANCE_COMPLETED',
        points: 9,
        label: 'نمونه — نیازمند تصویب',
      })
      .expect(201);

    const userId = `USR-REF-${id('subject')}`;
    await runUnscoped('the suite grants a reward so a balance exists to read', () =>
      harness.prisma.client.rewardBalance.create({
        data: { organizationId: org, userId, totalPoints: 9, lifetimeCreditMinor: 0n },
      }),
    );

    const response = await request(http)
      .get('/v1/rewards/me')
      .set(
        'authorization',
        `Bearer ${bearer({ sub: userId, rastaUserId: userId, organizationId: org, organizationIds: [org], roles: ['ORGANIZATION_ADMIN'] })}`,
      )
      .expect(200);

    expect(response.body.balance).not.toBeNull();
    expect(response.body.balance.userId).toBe(userId);
    expect(response.body.balance.totalPoints).toBe(9);
    // Computed and published, but conferring nothing — docs/24 Q-13 is open.
    expect(response.body.balance.level).toBeNull();
  });
});
