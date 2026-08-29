import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, auditor, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The ledger and the governance configuration, over HTTP.
 *
 * Two properties are asserted here that exist nowhere else above the domain:
 *
 *  - **A reversal is the ledger's only correction** (AGENTS.md A-06). It posts
 *    a mirror journal, leaves history untouched, and can happen at most once —
 *    enforced by a unique constraint rather than by a check two concurrent
 *    requests could both pass.
 *
 *  - **A rate is configuration, never code** (ADR-023). Creating one is
 *    restricted to `SYSTEM_ADMIN` because the steering group approves it and
 *    the platform must record who applied their decision; closing one is a
 *    `validTo`, never a delete, because a commission already charged
 *    references the rule that produced it.
 */
describe('ledger and governance API', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('LEDGER-A');
  const payee = apiTenant('LEDGER-B');

  const asOrg = () => `Bearer ${admin(org)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asPlatform = () => `Bearer ${admin(org, ['UNION_ADMIN'])}`;
  const asSystem = () => `Bearer ${admin(org, ['SYSTEM_ADMIN'])}`;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', asOrg());
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('api-ledger-fund'))
      .send({ amountMinor: '50000000' })
      .expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee()).expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, payee]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Reading the ledger
  // -------------------------------------------------------------------------

  it('lists this organization’s accounts and one account’s entries', async () => {
    const accounts = await request(http)
      .get('/v1/ledger/accounts')
      .set('authorization', asOrg())
      .expect(200);

    expect(accounts.body.items.length).toBeGreaterThan(0);
    for (const account of accounts.body.items) expect(account.organizationId).toBe(org);

    const wallet = accounts.body.items.find(
      (account: { purpose: string }) => account.purpose === 'WALLET',
    );
    expect(wallet).toBeDefined();

    const entries = await request(http)
      .get(`/v1/ledger/accounts/${wallet.id}/entries?limit=10`)
      .set('authorization', asOrg())
      .expect(200);
    expect(entries.body.items.length).toBeGreaterThan(0);
    expect(typeof entries.body.items[0].amountMinor).toBe('string');
  });

  it("refuses another organization's account, and an account that does not exist", async () => {
    const mine = await request(http)
      .get('/v1/ledger/accounts')
      .set('authorization', asOrg())
      .expect(200);

    await request(http)
      .get(`/v1/ledger/accounts/${mine.body.items[0].id}/entries`)
      .set('authorization', asPayee())
      .expect(404);

    await request(http)
      .get('/v1/ledger/accounts/ACC_0000000000000000000000000/entries')
      .set('authorization', asOrg())
      .expect(404);
  });

  it('serves the trial balance to platform scope only, and it balances', async () => {
    const refused = await request(http)
      .get('/v1/ledger/trial-balance?currency=IRR')
      .set('authorization', asOrg())
      .expect(403);
    // A per-tenant slice of a double-entry ledger does not balance, because a
    // settlement's counterparty and commission legs belong elsewhere — so this
    // report is platform-wide by nature (docs/10 § 10.13).
    expect(refused.body.code).toBe('INSUFFICIENT_ROLE');

    const balance = await request(http)
      .get('/v1/ledger/trial-balance?currency=IRR')
      .set('authorization', asPlatform())
      .expect(200);

    expect(balance.body.balanced).toBe(true);
    expect(BigInt(balance.body.totalDebitMinor)).toBe(BigInt(balance.body.totalCreditMinor));
    expect(balance.body.accounts.length).toBeGreaterThan(0);
  });

  it('refuses the oversight role the ledger entirely', async () => {
    const token = `Bearer ${auditor(org)}`;
    await request(http).get('/v1/ledger/accounts').set('authorization', token).expect(403);
    await request(http)
      .get('/v1/ledger/trial-balance?currency=IRR')
      .set('authorization', token)
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // Reversal — the ledger's only correction
  // -------------------------------------------------------------------------

  it('reverses a journal exactly once, returning the balances it had before', async () => {
    const walletBefore = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asOrg())
      .expect(200);

    const topUp = await request(http)
      .post(`/v1/wallets/${walletBefore.body.id}/top-up`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('api-reversible'))
      .send({ amountMinor: '11000' })
      .expect(201);

    const journal = await request(http)
      .get(`/v1/ledger/journals/${topUp.body.journalId}`)
      .set('authorization', asOrg())
      .expect(200);

    // Σ debit = Σ credit, per currency. docs/10 § 10.12's first mandatory row,
    // asserted here on the journal the API actually returned.
    let delta = 0n;
    for (const entry of journal.body.entries) {
      delta += entry.direction === 'DEBIT' ? BigInt(entry.amountMinor) : -BigInt(entry.amountMinor);
    }
    expect(delta).toBe(0n);

    // A short reason is refused: it is the only explanation an auditor will
    // have a year later.
    await request(http)
      .post(`/v1/ledger/journals/${topUp.body.journalId}/reverse`)
      .set('authorization', asPlatform())
      .send({ reason: 'oops' })
      .expect(400);

    // And an organization administrator may not reverse at all — a reversal
    // changes what two organizations' balances are.
    await request(http)
      .post(`/v1/ledger/journals/${topUp.body.journalId}/reverse`)
      .set('authorization', asOrg())
      .send({ reason: 'attempted by an organization administrator' })
      .expect(403);

    const reversal = await request(http)
      .post(`/v1/ledger/journals/${topUp.body.journalId}/reverse`)
      .set('authorization', asPlatform())
      .send({ reason: 'the top-up was recorded against the wrong organization' })
      .expect(201);

    expect(reversal.body.reversesId).toBe(topUp.body.journalId);

    const walletAfter = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asOrg())
      .expect(200);
    expect(BigInt(walletAfter.body.ledgerBalanceMinor)).toBe(
      BigInt(walletBefore.body.ledgerBalanceMinor),
    );

    // At most once, and enforced by a unique constraint rather than by a read
    // two concurrent requests could both pass.
    await request(http)
      .post(`/v1/ledger/journals/${topUp.body.journalId}/reverse`)
      .set('authorization', asPlatform())
      .send({ reason: 'a second reversal of the same journal must be refused' })
      .expect(409);

    // The original journal is unchanged: history is not edited, it is added to.
    const original = await request(http)
      .get(`/v1/ledger/journals/${topUp.body.journalId}`)
      .set('authorization', asOrg())
      .expect(200);
    expect(original.body.reversesId).toBeNull();
    expect(original.body.entries).toHaveLength(journal.body.entries.length);
  });

  it('answers 404 for a journal that does not exist', async () => {
    await request(http)
      .get('/v1/ledger/journals/JRN_0000000000000000000000000')
      .set('authorization', asOrg())
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Commission rules
  // -------------------------------------------------------------------------

  it('lets only a system administrator configure a commission rate', async () => {
    const body = {
      organizationId: org,
      transactionType: 'MARKETPLACE_ORDER',
      rateBasisPoints: 250,
      label: 'نمونه — نیازمند تصویب',
    };

    await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asOrg())
      .send(body)
      .expect(403);

    // docs/10 § 10.7 requires SYSTEM_ADMIN specifically: the rate is approved
    // by the steering group and the platform records who applied it.
    await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asPlatform())
      .send(body)
      .expect(403);

    const created = await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send(body)
      .expect(201);

    expect(created.body.rateBasisPoints).toBe(250);
    expect(created.body.status).toBe('ACTIVE');

    const listed = await request(http)
      .get('/v1/commissions/rules?transactionType=MARKETPLACE_ORDER')
      .set('authorization', asOrg())
      .expect(200);
    expect(listed.body.items.some((rule: { id: string }) => rule.id === created.body.id)).toBe(
      true,
    );

    // Closing a rule is a `validTo`, never a delete: a commission already
    // charged references the rule that produced it.
    const closed = await request(http)
      .patch(`/v1/commissions/rules/${created.body.id}`)
      .set('authorization', asSystem())
      .send({ status: 'INACTIVE' })
      .expect(200);
    expect(closed.body.status).toBe('INACTIVE');
  });

  it('refuses a rate outside nought to one hundred per cent', async () => {
    const response = await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send({
        organizationId: org,
        transactionType: 'LOGISTICS',
        rateBasisPoints: 10_001,
      })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('charges the configured rate on a settlement and reports the rule that matched', async () => {
    await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send({
        // Against the **payee**: the commission is deducted from the proceeds
        // of the organization being paid, not added to what the payer owes
        // (docs/10 § 10.7). A rule written against the payer would match
        // nothing, and the settlement would report `commissionRuleMatched:
        // false` — which is exactly how a misconfigured rate hides.
        organizationId: payee,
        transactionType: 'CONSTRUCTION_STATEMENT',
        rateBasisPoints: 500,
        label: 'نمونه — نیازمند تصویب',
      })
      .expect(201);

    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asOrg())
      .set('idempotency-key', id('api-commissioned'))
      .send({
        transactionType: 'CONSTRUCTION_STATEMENT',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '1000000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);

    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', asOrg())
      .set('idempotency-key', id('api-commissioned-auth'))
      .expect(200);

    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', asOrg())
      .set('idempotency-key', id('api-commissioned-settle'))
      .send({ transactionId: created.body.id })
      .expect(201);

    // 5% of 1 000 000 minor units, exactly — the whole reason a rate is an
    // integer in basis points rather than a decimal percentage (ADR-022).
    expect(settled.body.commissionRuleMatched).toBe(true);
    expect(BigInt(settled.body.commissionAmountMinor)).toBe(50_000n);
    expect(BigInt(settled.body.netAmountMinor)).toBe(950_000n);

    // The commission row belongs to the organization that paid it — the payee.
    const commissions = await request(http)
      .get('/v1/commissions?limit=10')
      .set('authorization', asPayee())
      .expect(200);
    const charged = commissions.body.items.find(
      (row: { transactionId: string }) => row.transactionId === created.body.id,
    );
    expect(charged).toBeDefined();
    expect(charged.rateBasisPoints).toBe(500);
    expect(charged.ruleId).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Reward rules
  // -------------------------------------------------------------------------

  it('configures a points-only reward rule, and refuses a cap with no window', async () => {
    const created = await request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .send({
        organizationId: org,
        triggerEvent: 'USAGE_RECORDED',
        points: 10,
        periodCap: 100,
        periodType: 'DAY',
        label: 'نمونه — نیازمند تصویب',
      })
      .expect(201);

    // No `creditPerPointMinor`, so the rule is points-only and posts no
    // journal — the honest state while docs/24 Q-09 is open (ADR-033).
    expect(created.body.creditPerPointMinor).toBeNull();

    const capless = await request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .send({ organizationId: org, triggerEvent: 'USAGE_RECORDED', points: 5, periodCap: 50 })
      .expect(400);
    expect(capless.body.code).toBe('VALIDATION_FAILED');

    const listed = await request(http)
      .get('/v1/rewards/rules?triggerEvent=USAGE_RECORDED')
      .set('authorization', asOrg())
      .expect(200);
    expect(listed.body.items.some((rule: { id: string }) => rule.id === created.body.id)).toBe(
      true,
    );

    const updated = await request(http)
      .patch(`/v1/rewards/rules/${created.body.id}`)
      .set('authorization', asSystem())
      .send({ points: 20 })
      .expect(200);
    expect(updated.body.points).toBe(20);
  });

  it('refuses a cashback rule while the regulatory review is outstanding', async () => {
    // The product document conditions cashback on a review
    // ("در صورت امکان و پس از بررسی مقرراتی"), so the type is refused rather
    // than accepted and silently ignored — a rule that exists and does nothing
    // is a control claiming something it does not have (docs/24 Q-07).
    const response = await request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .send({
        organizationId: org,
        triggerEvent: 'MAINTENANCE_COMPLETED',
        rewardType: 'CASHBACK',
        points: 5,
      })
      .expect(422);

    expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('serves a reward balance to the roles that earn points, and not to the auditor', async () => {
    const mine = await request(http)
      .get('/v1/rewards/me')
      .set('authorization', asOrg())
      .expect(200);

    // `balance` is null until this user has been granted something, and null
    // rather than a fabricated zero row: "no points yet" and "a balance of
    // zero" are different facts, and only one of them is true here.
    expect(mine.body.balance).toBeNull();
    expect(mine.body.rewards).toEqual([]);

    // A driver earns points, so a driver may read their own balance.
    await request(http)
      .get('/v1/rewards/me')
      .set('authorization', `Bearer ${admin(org, ['DRIVER'])}`)
      .expect(200);

    await request(http)
      .get('/v1/rewards/me')
      .set('authorization', `Bearer ${auditor(org)}`)
      .expect(403);
  });
});
