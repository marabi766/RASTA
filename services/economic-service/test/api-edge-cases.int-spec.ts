import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The decisions that only happen at the edges.
 *
 * Everything here is a branch that changes a financial outcome and that a
 * happy path never reaches: a rate with a floor and a ceiling, a rule closed
 * before it opened, a refund of money that has since been spent, a hold placed
 * on a frozen wallet, a page of results after the first.
 *
 * They are grouped by the decision rather than by the file, because that is
 * how they fail: "the ceiling was not applied" is one defect whether it
 * originates in the rule engine, the service or the schema.
 */
describe('economic edge cases', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('EDGE-A');
  const payee = apiTenant('EDGE-B');
  const frozen = apiTenant('EDGE-FROZEN');

  const asOrg = () => `Bearer ${admin(org)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asSystem = () => `Bearer ${admin(org, ['SYSTEM_ADMIN'])}`;
  const asPlatform = () => `Bearer ${admin(org, ['UNION_ADMIN'])}`;

  async function fund(token: string, amountMinor: string): Promise<string> {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', token);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', token)
      .set('idempotency-key', id('edge-fund'))
      .send({ amountMinor })
      .expect(201);
    return wallet.body.id;
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    await fund(asOrg(), '80000000');
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, payee, frozen]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Commission configuration
  // -------------------------------------------------------------------------

  describe('a commission rule', () => {
    it('accepts a floor, a ceiling, a window and a provenance label', async () => {
      const from = new Date(Date.now() - 3600_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();

      const created = await request(http)
        .post('/v1/commissions/rules')
        .set('authorization', asSystem())
        .send({
          organizationId: payee,
          transactionType: 'PROCUREMENT_ORDER',
          rateBasisPoints: 1000,
          // The floor and the ceiling are on the **commission**, not on the
          // transaction: a 10% rate on a tiny order still costs the platform
          // something to broker, and on a very large one it should not scale
          // without limit (docs/10 § 10.7).
          minAmountMinor: '5000',
          maxAmountMinor: '20000',
          validFrom: from,
          validTo: to,
          status: 'ACTIVE',
          label: 'نمونه — نیازمند تصویب',
        })
        .expect(201);

      expect(created.body.minAmountMinor).toBe('5000');
      expect(created.body.maxAmountMinor).toBe('20000');
      expect(created.body.validTo).not.toBeNull();
      // Demonstration data must be labelled so a sample rate can never be
      // mistaken for an approved one (ADR-023).
      expect(created.body.label).toBe('نمونه — نیازمند تصویب');
    });

    it('is refused when it would close before it opened', async () => {
      const response = await request(http)
        .post('/v1/commissions/rules')
        .set('authorization', asSystem())
        .send({
          organizationId: payee,
          transactionType: 'LOGISTICS',
          rateBasisPoints: 100,
          validFrom: new Date(Date.now() + 86_400_000).toISOString(),
          validTo: new Date().toISOString(),
        })
        .expect(422);

      // A window that never opens is a rule that silently charges nothing.
      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('applies its ceiling rather than the raw rate', async () => {
      // 10% of 1 000 000 is 100 000, well over the 20 000 ceiling configured
      // above. The ceiling is the number that must be charged.
      const created = await request(http)
        .post('/v1/transactions')
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-capped'))
        .send({
          transactionType: 'PROCUREMENT_ORDER',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '1000000',
          currency: 'IRR',
          holdFunds: true,
        })
        .expect(201);

      await request(http)
        .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-capped-auth'))
        .expect(200);

      const settled = await request(http)
        .post('/v1/settlements')
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-capped-settle'))
        .send({ transactionId: created.body.id })
        .expect(201);

      expect(settled.body.commissionRuleMatched).toBe(true);
      expect(BigInt(settled.body.commissionAmountMinor)).toBe(20_000n);
      expect(BigInt(settled.body.netAmountMinor)).toBe(980_000n);
    });

    it('applies its floor when the rate would charge less', async () => {
      // 10% of 20 000 is 2 000, below the 5 000 floor.
      const created = await request(http)
        .post('/v1/transactions')
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-floored'))
        .send({
          transactionType: 'PROCUREMENT_ORDER',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '20000',
          currency: 'IRR',
          holdFunds: true,
        })
        .expect(201);

      await request(http)
        .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-floored-auth'))
        .expect(200);

      const settled = await request(http)
        .post('/v1/settlements')
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-floored-settle'))
        .send({ transactionId: created.body.id })
        .expect(201);

      expect(BigInt(settled.body.commissionAmountMinor)).toBe(5_000n);
    });

    it('is closed with a date, reopened by clearing it, and never deleted', async () => {
      const created = await request(http)
        .post('/v1/commissions/rules')
        .set('authorization', asSystem())
        .send({ organizationId: org, transactionType: 'LOGISTICS', rateBasisPoints: 100 })
        .expect(201);

      const closed = await request(http)
        .patch(`/v1/commissions/rules/${created.body.id}`)
        .set('authorization', asSystem())
        .send({ validTo: new Date().toISOString() })
        .expect(200);
      expect(closed.body.validTo).not.toBeNull();

      // Nulling it reopens an indefinite rule — a commission already charged
      // references this row, so it must never be removed.
      const reopened = await request(http)
        .patch(`/v1/commissions/rules/${created.body.id}`)
        .set('authorization', asSystem())
        .send({ validTo: null })
        .expect(200);
      expect(reopened.body.validTo).toBeNull();

      const repriced = await request(http)
        .patch(`/v1/commissions/rules/${created.body.id}`)
        .set('authorization', asSystem())
        .send({ rateBasisPoints: 175, status: 'INACTIVE', label: 'بازبینی‌شده' })
        .expect(200);
      expect(repriced.body.rateBasisPoints).toBe(175);
      expect(repriced.body.status).toBe('INACTIVE');
      expect(repriced.body.label).toBe('بازبینی‌شده');
    });

    it('answers 404 for a rule that does not exist', async () => {
      await request(http)
        .patch('/v1/commissions/rules/CMR_0000000000000000000000000')
        .set('authorization', asSystem())
        .send({ status: 'INACTIVE' })
        .expect(404);
    });

    it('lists every rule when no type is named, and pages the charges', async () => {
      const all = await request(http)
        .get('/v1/commissions/rules')
        .set('authorization', asOrg())
        .expect(200);
      expect(all.body.items.length).toBeGreaterThan(0);

      // Two settlements above charged this organization, so there is a second
      // page to reach.
      const first = await request(http)
        .get('/v1/commissions?limit=1')
        .set('authorization', asPayee())
        .expect(200);
      expect(first.body.items).toHaveLength(1);

      // The cursor is the last item's id. Unlike the other collections this
      // one does not return a `nextCursor`, so a client has to supply it — the
      // paging still works, and this asserts that it does.
      const second = await request(http)
        .get(`/v1/commissions?limit=1&cursor=${first.body.items[0].id}`)
        .set('authorization', asPayee())
        .expect(200);
      expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);
    });
  });

  // -------------------------------------------------------------------------
  // Reward configuration
  // -------------------------------------------------------------------------

  describe('a reward rule', () => {
    /**
     * A fresh rule per test.
     *
     * Not a `let` filled in by the first case: CI runs this suite a second
     * time under `--testNamePattern`, and the pattern matches "capped" but not
     * "accepts", so the shared value would be `undefined` and the PATCH would
     * hit `/rules/undefined`. A test that only passes when its neighbour ran
     * first is exactly what AGENTS.md § 5 forbids — and this is how it was
     * caught.
     */
    async function createRule(): Promise<string> {
      const created = await request(http)
        .post('/v1/rewards/rules')
        .set('authorization', asSystem())
        .send({
          organizationId: org,
          triggerEvent: 'USAGE_RECORDED',
          rewardType: 'POINTS',
          points: 12,
          creditPerPointMinor: '1000',
          periodCap: 500,
          periodType: 'MONTH',
          label: 'نمونه — نیازمند تصویب',
        })
        .expect(201);
      return created.body.id as string;
    }

    it('accepts every optional field the schema offers', async () => {
      const created = await request(http)
        .post('/v1/rewards/rules')
        .set('authorization', asSystem())
        .send({
          organizationId: org,
          triggerEvent: 'USAGE_RECORDED',
          rewardType: 'POINTS',
          points: 12,
          creditPerPointMinor: '1000',
          periodCap: 500,
          periodType: 'MONTH',
          condition: { all: [{ field: 'assetId', op: 'present' }] },
          validFrom: new Date(Date.now() - 3600_000).toISOString(),
          validTo: new Date(Date.now() + 86_400_000).toISOString(),
          status: 'ACTIVE',
          label: 'نمونه — نیازمند تصویب',
        })
        .expect(201);

      // With a conversion rate set, a grant stops being a display number and
      // becomes a recorded platform expense (ADR-033).
      expect(created.body.creditPerPointMinor).toBe('1000');
      expect(created.body.periodCap).toBe(500);
    });

    it('is repriced, capped, closed and reopened one field at a time', async () => {
      const ruleId = await createRule();

      const points = await request(http)
        .patch(`/v1/rewards/rules/${ruleId}`)
        .set('authorization', asSystem())
        .send({ points: 20 })
        .expect(200);
      expect(points.body.points).toBe(20);

      // Clearing the conversion rate returns the rule to points-only, which is
      // the honest state while docs/24 Q-09 is unanswered.
      const demonetised = await request(http)
        .patch(`/v1/rewards/rules/${ruleId}`)
        .set('authorization', asSystem())
        .send({ creditPerPointMinor: null })
        .expect(200);
      expect(demonetised.body.creditPerPointMinor).toBeNull();

      const remonetised = await request(http)
        .patch(`/v1/rewards/rules/${ruleId}`)
        .set('authorization', asSystem())
        .send({ creditPerPointMinor: '2000', periodCap: 100, label: 'بازبینی‌شده' })
        .expect(200);
      expect(remonetised.body.creditPerPointMinor).toBe('2000');
      expect(remonetised.body.periodCap).toBe(100);

      const closed = await request(http)
        .patch(`/v1/rewards/rules/${ruleId}`)
        .set('authorization', asSystem())
        .send({ validTo: new Date().toISOString(), status: 'INACTIVE' })
        .expect(200);
      expect(closed.body.status).toBe('INACTIVE');

      const reopened = await request(http)
        .patch(`/v1/rewards/rules/${ruleId}`)
        .set('authorization', asSystem())
        .send({ validTo: null })
        .expect(200);
      expect(reopened.body.validTo).toBeNull();
    });

    it('answers 404 for a rule that does not exist, and lists all triggers', async () => {
      await request(http)
        .patch('/v1/rewards/rules/RWR_0000000000000000000000000')
        .set('authorization', asSystem())
        .send({ points: 1 })
        .expect(404);

      const all = await request(http)
        .get('/v1/rewards/rules')
        .set('authorization', asOrg())
        .expect(200);
      expect(all.body.items.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  describe('a top-up refund', () => {
    it('is refused for a payment that never captured', async () => {
      const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

      const failed = await request(http)
        .post(`/v1/wallets/${wallet.body.id}/top-up`)
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-failed-topup'))
        .send({ amountMinor: '4000', instrument: 'fail:INSUFFICIENT_FUNDS' })
        .expect(201);

      const response = await request(http)
        .post(`/v1/payment-intents/${failed.body.paymentIntentId}/refund`)
        .set('authorization', asPlatform())
        .set('idempotency-key', id('edge-refund-failed'))
        .send({ reason: 'attempting to refund a payment that never captured' })
        .expect(409);

      // There is nothing to return. Posting a reversal of a journal that was
      // never written would credit money the platform never received.
      expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('is refused a second time', async () => {
      const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());

      const topUp = await request(http)
        .post(`/v1/wallets/${wallet.body.id}/top-up`)
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-once'))
        .send({ amountMinor: '6000' })
        .expect(201);

      await request(http)
        .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
        .set('authorization', asPlatform())
        .set('idempotency-key', id('edge-once-refund'))
        .send({ reason: 'the first refund, which must succeed' })
        .expect(200);

      await request(http)
        .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
        .set('authorization', asPlatform())
        .set('idempotency-key', id('edge-once-refund-again'))
        .send({ reason: 'the second refund, which must not' })
        .expect(409);
    });

    it('answers 404 for a payment intent in another organization', async () => {
      const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());
      const topUp = await request(http)
        .post(`/v1/wallets/${wallet.body.id}/top-up`)
        .set('authorization', asOrg())
        .set('idempotency-key', id('edge-foreign'))
        .send({ amountMinor: '3000' })
        .expect(201);

      await request(http)
        .post(`/v1/payment-intents/${topUp.body.paymentIntentId}/refund`)
        .set('authorization', `Bearer ${admin(payee, ['UNION_ADMIN'])}`)
        .set('idempotency-key', id('edge-foreign-refund'))
        .send({ reason: 'a platform administrator of another organization' })
        .expect(404);
    });

    it('pages the payment intents it produced', async () => {
      const first = await request(http)
        .get('/v1/payment-intents?limit=1')
        .set('authorization', asOrg())
        .expect(200);
      expect(first.body.items).toHaveLength(1);

      if (first.body.nextCursor) {
        const second = await request(http)
          .get(`/v1/payment-intents?limit=1&cursor=${first.body.nextCursor}`)
          .set('authorization', asOrg())
          .expect(200);
        expect(second.body.items[0]?.id).not.toBe(first.body.items[0].id);
      }
    });
  });

  // -------------------------------------------------------------------------
  // A wallet that is not ACTIVE
  // -------------------------------------------------------------------------

  describe('a frozen wallet', () => {
    let walletId: string;

    beforeAll(async () => {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(frozen)}`)
        .expect(200);
      walletId = wallet.body.id;

      // Written directly, because there is no endpoint that freezes a wallet:
      // it is an operator action the platform does not expose yet. The state
      // exists in the schema and every money-moving path checks it, so the
      // check has to be exercised from the state rather than from an API that
      // would have to be invented to reach it.
      await runUnscoped('the edge-case suite freezes a wallet it owns', () =>
        harness.prisma.client.wallet.update({
          where: { id: walletId },
          data: { status: 'FROZEN' },
        }),
      );
    });

    it('takes no money in', async () => {
      const response = await request(http)
        .post(`/v1/wallets/${walletId}/top-up`)
        .set('authorization', `Bearer ${admin(frozen)}`)
        .set('idempotency-key', id('edge-frozen-topup'))
        .send({ amountMinor: '1000' })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('lets no money out', async () => {
      const response = await request(http)
        .post('/v1/transactions')
        .set('authorization', `Bearer ${admin(frozen)}`)
        .set('idempotency-key', id('edge-frozen-hold'))
        .send({
          transactionType: 'LOGISTICS',
          counterpartyOrganizationId: payee,
          grossAmountMinor: '1000',
          currency: 'IRR',
          holdFunds: true,
        })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });
  });

  // -------------------------------------------------------------------------
  // Paging the ledger
  // -------------------------------------------------------------------------

  it('pages an account statement, and never repeats an entry across pages', async () => {
    const accounts = await request(http)
      .get('/v1/ledger/accounts')
      .set('authorization', asOrg())
      .expect(200);
    const wallet = accounts.body.items.find(
      (account: { purpose: string }) => account.purpose === 'WALLET',
    );

    const first = await request(http)
      .get(`/v1/ledger/accounts/${wallet.id}/entries?limit=2`)
      .set('authorization', asOrg())
      .expect(200);
    expect(first.body.items.length).toBeLessThanOrEqual(2);

    if (first.body.hasMore) {
      expect(first.body.nextCursor).toBeTruthy();
      const second = await request(http)
        .get(`/v1/ledger/accounts/${wallet.id}/entries?limit=2&cursor=${first.body.nextCursor}`)
        .set('authorization', asOrg())
        .expect(200);

      const firstIds = new Set(first.body.items.map((entry: { id: string }) => entry.id));
      for (const entry of second.body.items) expect(firstIds.has(entry.id)).toBe(false);
    }
  });

  it('reports a transaction window, and an empty one honestly', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 172_800_000).toISOString();

    const empty = await request(http)
      .get(`/v1/transactions?from=${future}&to=${later}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(empty.body.items).toHaveLength(0);
    expect(empty.body.hasMore).toBe(false);
    expect(empty.body.nextCursor).toBeNull();

    const past = new Date(Date.now() - 86_400_000).toISOString();
    const now = new Date(Date.now() + 60_000).toISOString();
    const populated = await request(http)
      .get(`/v1/transactions?from=${past}&to=${now}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(populated.body.items.length).toBeGreaterThan(0);
  });

  it('records an obligation dated when the business event happened, not when it was reported', async () => {
    // The commission rule is selected against `occurredAt`, so a transaction
    // recorded late is still charged the rate that was in force when it
    // occurred (docs/10 § 10.7).
    const occurredAt = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asOrg())
      .set('idempotency-key', id('edge-backdated'))
      .send({
        transactionType: 'MAINTENANCE_SERVICE',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '2000',
        occurredAt,
        holdFunds: false,
      })
      .expect(201);

    expect(new Date(created.body.occurredAt).toISOString()).toBe(occurredAt);
    // No currency given, so the platform's default applies rather than a
    // guess — and it is stated on the row rather than left implicit.
    expect(created.body.currency).toBe('IRR');
  });
});
