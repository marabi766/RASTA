import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, auditor, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { RewardService } from '../src/reward/reward.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IdempotencyStore } from '../src/shared/idempotency';

/**
 * What the service answers, serialised the way production serialises it:
 * **without** the test runner's `BigInt.prototype.toJSON` (economic audit F1).
 *
 * `jest.setup.cjs` teaches every suite to serialise a `bigint`, so that a
 * failing money assertion is reported rather than lost. It also taught the
 * application under test: the reward rule routes returned the Prisma row with
 * a native `bigint` `creditPerPointMinor`, every suite passed, and in
 * production a monetised rule's create committed and then answered 500 — and
 * the administrator's retry created a second rule paying for the same fact.
 *
 * This file removes the shim before anything is served, so Express's
 * `JSON.stringify` on the server side of the real HTTP exchange is the one
 * production runs. Its first test proves the shim is gone; the rest exercise
 * every route that answers money — the reward rules first (POST, its replay,
 * GET, PATCH), then the others — so a raw row anywhere is a 500 here.
 * Nothing in this file asserts on a `bigint`, because a failed assertion
 * carrying one is what the shim existed to report.
 */
delete (BigInt.prototype as { toJSON?: unknown }).toJSON;

/** 2^53 + 1: the first integer a JSON number cannot carry. */
const BEYOND_DOUBLE = '9007199254740993';

describe('responses serialised without the bigint shim', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('WIRE');
  const otherOrg = apiTenant('WIRE-OTHER');
  const payee = apiTenant('WIRE-PAYEE');
  const person = `wire-${ulid().slice(-8)}`;

  /** One system administrator: the same subject and issuer on every call. */
  const asSystem = (roles = ['SYSTEM_ADMIN'], organizationId = org) =>
    `Bearer ${bearer({
      sub: `sub-${person}`,
      rastaUserId: `USR-${person}`,
      organizationId,
      organizationIds: [organizationId],
      roles,
    })}`;
  const asOtherSystemAdmin = () => `Bearer ${admin(org, ['SYSTEM_ADMIN'], 'second-admin')}`;

  const ruleBody = (label: string) => ({
    organizationId: org,
    triggerEvent: 'USAGE_RECORDED',
    points: 1,
    creditPerPointMinor: BEYOND_DOUBLE,
    periodCap: 40,
    periodType: 'DAY',
    label,
  });

  const createRule = (body: Record<string, unknown>, key?: string, token = asSystem()) => {
    const call = request(http).post('/v1/rewards/rules').set('authorization', token);
    return (key === undefined ? call : call.set('idempotency-key', key)).send(body);
  };

  const rulesLabelled = (label: string) =>
    runUnscoped('the suite counts the rules it created', () =>
      harness.prisma.client.rewardRule.findMany({ where: { label }, select: { id: true } }),
    );

  const changeRecordsOf = (ruleId: string) =>
    runUnscoped('the suite counts the change records it caused', () =>
      harness.prisma.client.outboxMessage.count({
        where: { eventName: 'REWARD_RULE_CHANGED', aggregateId: ruleId },
      }),
    );

  const keyRow = (key: string, organizationId = org) =>
    runUnscoped('the suite reads the key records it caused', () =>
      harness.prisma.client.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: { organizationId, endpoint: 'POST /v1/rewards/rules', key },
        },
        select: { state: true },
      }),
    );

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await runUnscoped('the suite removes the rules it created', () =>
      harness.prisma.client.rewardRule.deleteMany({
        where: { organizationId: { in: [org, otherOrg] } },
      }),
    );
    await cleanup(harness.prisma, [org, otherOrg, payee]);
    await harness.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs with the shim removed: a bigint does not serialise in this file', () => {
    // The precondition every other test rests on. With the shim present this
    // returns '{"v":"1"}', and nothing below would prove anything.
    expect(() => JSON.stringify({ v: BigInt(1) })).toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // Reward rules: the view, on every route
  // -------------------------------------------------------------------------

  describe('reward rules', () => {
    it('answers a monetised rule’s create with the credit as an exact decimal string', async () => {
      const label = `wire-create-${ulid()}`;
      const response = await createRule(ruleBody(label), id('wire-rule')).expect(201);

      // Above 2^53, so a JSON number would have rounded it to …992.
      expect(response.text).toContain(`"creditPerPointMinor":"${BEYOND_DOUBLE}"`);
      expect(response.body).toEqual({
        id: expect.stringMatching(/^RWR_/),
        organizationId: org,
        triggerEvent: 'USAGE_RECORDED',
        rewardType: 'POINTS',
        condition: null,
        points: 1,
        creditPerPointMinor: BEYOND_DOUBLE,
        // A number of points, not money.
        periodCap: 40,
        periodType: 'DAY',
        validFrom: expect.any(String),
        validTo: null,
        status: 'ACTIVE',
        label,
        createdAt: expect.any(String),
        createdBy: `USR-${person}`,
        updatedAt: expect.any(String),
        updatedBy: `USR-${person}`,
      });
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('keeps a points-only rule’s credit null, not "0"', async () => {
      const label = `wire-points-${ulid()}`;
      const response = await createRule(
        { organizationId: org, triggerEvent: 'USAGE_RECORDED', points: 3, label },
        id('wire-points'),
      ).expect(201);
      expect(response.body.creditPerPointMinor).toBeNull();
      expect(response.body.periodCap).toBeNull();
    });

    it('lists and updates through the same view', async () => {
      const label = `wire-list-${ulid()}`;
      const created = await createRule(ruleBody(label), id('wire-list')).expect(201);

      const listed = await request(http)
        .get('/v1/rewards/rules?triggerEvent=USAGE_RECORDED')
        .set('authorization', asSystem())
        .expect(200);
      const item = (listed.body.items as { id: string }[]).find(
        (rule) => rule.id === created.body.id,
      );
      expect(item).toEqual(created.body);
      expect(listed.text).toContain(`"creditPerPointMinor":"${BEYOND_DOUBLE}"`);

      const updated = await request(http)
        .patch(`/v1/rewards/rules/${created.body.id}`)
        .set('authorization', asSystem())
        .send({ label: `${label}-renamed` })
        .expect(200);
      expect(updated.body).toEqual({
        ...created.body,
        label: `${label}-renamed`,
        updatedAt: expect.any(String),
      });
    });

    // ---- Idempotency (docs/06 § 6.8) --------------------------------------

    it('replays the first rule to a retry — one rule, one change record', async () => {
      const label = `wire-replay-${ulid()}`;
      const key = id('wire-replay');
      const first = await createRule(ruleBody(label), key).expect(201);
      const retry = await createRule(ruleBody(label), key).expect(201);

      expect(retry.body).toEqual(first.body);
      expect(retry.text).toContain(`"creditPerPointMinor":"${BEYOND_DOUBLE}"`);
      expect(await rulesLabelled(label)).toHaveLength(1);
      expect(await changeRecordsOf(first.body.id)).toBe(1);
    });

    it('refuses a create without a key, and writes nothing', async () => {
      const label = `wire-nokey-${ulid()}`;
      const response = await createRule(ruleBody(label)).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await rulesLabelled(label)).toHaveLength(0);
    });

    it('refuses the same key with another body, and writes nothing', async () => {
      const label = `wire-reuse-${ulid()}`;
      const key = id('wire-reuse');
      await createRule(ruleBody(label), key).expect(201);

      const other = await createRule({ ...ruleBody(label), points: 2 }, key).expect(409);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(other.text).not.toContain('RWR_');
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('refuses the same key from another administrator, with nothing of the rule', async () => {
      const label = `wire-actor-${ulid()}`;
      const key = id('wire-actor');
      await createRule(ruleBody(label), key).expect(201);

      const stranger = await createRule(ruleBody(label), key, asOtherSystemAdmin()).expect(409);
      expect(stranger.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(stranger.text).not.toContain('RWR_');
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('scopes the key to the acting organization: another one is another request', async () => {
      const label = `wire-tenant-${ulid()}`;
      const key = id('wire-tenant');
      const first = await createRule(ruleBody(label), key).expect(201);

      const elsewhere = await createRule(
        { ...ruleBody(label), organizationId: otherOrg },
        key,
        asSystem(['SYSTEM_ADMIN'], otherOrg),
      ).expect(201);
      expect(elsewhere.body.id).not.toBe(first.body.id);
      expect(await keyRow(key)).toEqual({ state: 'COMPLETED' });
      expect(await keyRow(key, otherOrg)).toEqual({ state: 'COMPLETED' });
    });

    it('replays to nobody the route would refuse: the role is checked as the caller now is', async () => {
      const label = `wire-authz-${ulid()}`;
      const key = id('wire-authz');
      await createRule(ruleBody(label), key).expect(201);

      // The same person, no longer a system administrator; and the oversight role.
      for (const token of [asSystem(['ORGANIZATION_ADMIN']), `Bearer ${auditor(org)}`]) {
        const refused = await createRule(ruleBody(label), key, token).expect(403);
        // The error envelope and nothing else: no field of the stored rule.
        expect(Object.keys(refused.body).sort()).toEqual(
          ['code', 'correlationId', 'message', 'path', 'timestamp'].sort(),
        );
        expect(refused.text).not.toContain('RWR_');
      }
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('creates one rule for concurrent requests under one key', async () => {
      const label = `wire-race-${ulid()}`;
      const key = id('wire-race');
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => createRule(ruleBody(label), key)),
      );

      const statuses = responses.map((response) => response.status);
      // The winner and any replay answer 201; one still in flight is the
      // retryable 409 CONFLICT. Nothing else, and never a second rule.
      expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
      const created = responses.filter((response) => response.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(new Set(created.map((response) => response.body.id)).size).toBe(1);
      for (const response of responses.filter((r) => r.status === 409)) {
        expect(response.body.code).toBe('CONFLICT');
      }
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('rolls the rule back with its change record, and frees the key for the retry', async () => {
      const label = `wire-rollback-${ulid()}`;
      const key = id('wire-rollback');
      const ledger = harness.app.get(LedgerService);
      // The change record is written after the rule, in its transaction.
      jest.spyOn(ledger, 'enqueue').mockRejectedValueOnce(new Error('outbox write failed'));

      await createRule(ruleBody(label), key).expect(500);
      expect(await rulesLabelled(label)).toHaveLength(0);
      expect(await keyRow(key)).toBeNull();

      const retry = await createRule(ruleBody(label), key).expect(201);
      expect(await rulesLabelled(label)).toEqual([{ id: retry.body.id }]);
      expect(await changeRecordsOf(retry.body.id)).toBe(1);
    });

    it('stores the answer in the rule’s own transaction: no rule without its key', async () => {
      // Were the answer stored after the rule committed, a failure storing it
      // would free the key over a committed rule, and the retry would create a
      // second one. In the same transaction, it takes the rule with it.
      const label = `wire-atomic-${ulid()}`;
      const key = id('wire-atomic');
      const store = harness.app.get(IdempotencyStore) as unknown as {
        complete: (...args: unknown[]) => Promise<void>;
      };
      jest.spyOn(store, 'complete').mockRejectedValueOnce(new Error('key write failed'));

      await createRule(ruleBody(label), key).expect(500);
      expect(await rulesLabelled(label)).toHaveLength(0);
      expect(await keyRow(key)).toBeNull();

      await createRule(ruleBody(label), key).expect(201);
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('replays a rule whose first answer was lost after the commit', async () => {
      const label = `wire-lost-${ulid()}`;
      const key = id('wire-lost');
      const rewards = harness.app.get(RewardService);
      const original = rewards.createRule.bind(rewards);
      jest.spyOn(rewards, 'createRule').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('the connection dropped after the commit');
      });

      await createRule(ruleBody(label), key).expect(500);
      const [committed] = await rulesLabelled(label);
      expect(committed).toBeDefined();
      expect(await keyRow(key)).toEqual({ state: 'COMPLETED' });

      const retry = await createRule(ruleBody(label), key).expect(201);
      expect(retry.body.id).toBe(committed!.id);
      expect(retry.body.creditPerPointMinor).toBe(BEYOND_DOUBLE);
      expect(await rulesLabelled(label)).toHaveLength(1);
    });

    it('treats a key past its retention as new — the documented 24-hour limit', async () => {
      const label = `wire-expired-${ulid()}`;
      const key = id('wire-expired');
      const first = await createRule(ruleBody(label), key).expect(201);
      await runUnscoped('the suite ages the key it sent past its retention', () =>
        harness.prisma.client.idempotencyKey.updateMany({
          where: { organizationId: org, endpoint: 'POST /v1/rewards/rules', key },
          // `ck_idempotency_expiry`: a record expires after it was made.
          data: {
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            expiresAt: new Date(Date.now() - 1000),
          },
        }),
      );

      const late = await createRule(ruleBody(label), key).expect(201);
      expect(late.body.id).not.toBe(first.body.id);
      expect(await rulesLabelled(label)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Every other route that answers money
  // -------------------------------------------------------------------------

  describe('every other money route', () => {
    const asPayer = () => `Bearer ${admin(org)}`;
    const asPayee = () => `Bearer ${admin(payee)}`;
    const asPlatform = () => `Bearer ${admin(org, ['UNION_ADMIN'])}`;
    let walletId: string;
    let paymentIntentId: string;

    /** Each answer must be a 2xx — a raw `bigint` anywhere in it is a 500 here. */
    const ok = (response: request.Response, route: string) => {
      if (response.status >= 300) {
        throw new Error(`${route} answered ${response.status}: ${response.text}`);
      }
      return response;
    };

    beforeAll(async () => {
      const wallet = ok(
        await request(http).get('/v1/wallets/me').set('authorization', asPayer()),
        'GET /v1/wallets/me',
      );
      walletId = wallet.body.id as string;
      ok(
        await request(http).get('/v1/wallets/me').set('authorization', asPayee()),
        'GET /v1/wallets/me (payee)',
      );
      const topUp = ok(
        await request(http)
          .post(`/v1/wallets/${walletId}/top-up`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-topup'))
          .send({ amountMinor: '50000000' }),
        'POST /v1/wallets/{id}/top-up',
      );
      paymentIntentId = topUp.body.paymentIntentId as string;
    });

    it('wallets, holds, transactions, settlements, commissions, ledger and payments', async () => {
      const rule = ok(
        await request(http).post('/v1/commissions/rules').set('authorization', asSystem()).send({
          organizationId: payee,
          businessLine: 'LOGISTICS',
          rateBasisPoints: 250,
          minAmountMinor: '100',
          maxAmountMinor: BEYOND_DOUBLE,
        }),
        'POST /v1/commissions/rules',
      );
      expect(rule.body.maxAmountMinor).toBe(BEYOND_DOUBLE);
      ok(
        await request(http)
          .patch(`/v1/commissions/rules/${rule.body.id}`)
          .set('authorization', asSystem())
          .send({ label: 'wire' }),
        'PATCH /v1/commissions/rules/{id}',
      );
      ok(
        await request(http)
          .get('/v1/commissions/rules')
          .set('authorization', asSystem(['SYSTEM_ADMIN'], payee)),
        'GET /v1/commissions/rules',
      );

      const created = ok(
        await request(http)
          .post('/v1/transactions')
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-txn'))
          .send({
            transactionType: 'LOGISTICS',
            businessLine: 'LOGISTICS',
            counterpartyOrganizationId: payee,
            grossAmountMinor: '2000000',
            currency: 'IRR',
            holdFunds: true,
          }),
        'POST /v1/transactions',
      );
      const transactionId = created.body.id as string;
      ok(
        await request(http)
          .post(`/v1/transactions/${transactionId}/authorise-settlement`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-authorise')),
        'POST /v1/transactions/{id}/authorise-settlement',
      );
      const settled = ok(
        await request(http)
          .post('/v1/settlements')
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-settle'))
          .send({ transactionId }),
        'POST /v1/settlements',
      );
      expect(settled.body.commissionAmountMinor).toBe('50000');

      const reads: [string, string, string][] = [
        ['GET /v1/wallets/{id}', `/v1/wallets/${walletId}`, asPayer()],
        ['GET /v1/wallets/{id}/holds', `/v1/wallets/${walletId}/holds`, asPayer()],
        ['GET /v1/wallets/provider', '/v1/wallets/provider', asPayer()],
        ['GET /v1/transactions', '/v1/transactions', asPayer()],
        ['GET /v1/transactions/{id}', `/v1/transactions/${transactionId}`, asPayer()],
        ['GET /v1/settlements', '/v1/settlements', asPayer()],
        ['GET /v1/settlements/{id}', `/v1/settlements/${settled.body.settlementId}`, asPayer()],
        ['GET /v1/commissions', '/v1/commissions', asPayee()],
        ['GET /v1/ledger/accounts', '/v1/ledger/accounts', asPayer()],
        [
          'GET /v1/ledger/journals/{id}',
          `/v1/ledger/journals/${settled.body.journalId}`,
          asPayer(),
        ],
        ['GET /v1/ledger/trial-balance', '/v1/ledger/trial-balance', asPlatform()],
        ['GET /v1/payment-intents', '/v1/payment-intents', asPayer()],
        ['GET /v1/payment-intents/{id}', `/v1/payment-intents/${paymentIntentId}`, asPayer()],
        [
          'GET /v1/payment-intents/{id}/reconciliation',
          `/v1/payment-intents/${paymentIntentId}/reconciliation`,
          // The resolver role, SYSTEM_ADMIN by default.
          asSystem(),
        ],
        ['GET /v1/rewards/me', '/v1/rewards/me', asPayer()],
      ];
      for (const [route, path, token] of reads) {
        ok(await request(http).get(path).set('authorization', token), route);
      }

      const accounts = await request(http)
        .get('/v1/ledger/accounts')
        .set('authorization', asPayer());
      const walletAccount = (accounts.body.items as { id: string; purpose: string }[]).find(
        (account) => account.purpose === 'WALLET',
      );
      ok(
        await request(http)
          .get(`/v1/ledger/accounts/${walletAccount!.id}/entries`)
          .set('authorization', asPayer()),
        'GET /v1/ledger/accounts/{id}/entries',
      );

      // Money moving the other way: a hold refunded, and a top-up refunded.
      const held = ok(
        await request(http)
          .post('/v1/transactions')
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-txn-refund'))
          .send({
            transactionType: 'LOGISTICS',
            businessLine: 'LOGISTICS',
            counterpartyOrganizationId: payee,
            grossAmountMinor: '1000',
            currency: 'IRR',
            holdFunds: true,
          }),
        'POST /v1/transactions (hold)',
      );
      ok(
        await request(http)
          .post(`/v1/transactions/${held.body.id}/refund`)
          .set('authorization', asPayee())
          .set('idempotency-key', id('wire-refund'))
          .send({ reason: 'wire serialisation sweep' }),
        'POST /v1/transactions/{id}/refund',
      );
      // A top-up of its own, so the wallet still holds all of it.
      const small = ok(
        await request(http)
          .post(`/v1/wallets/${walletId}/top-up`)
          .set('authorization', asPayer())
          .set('idempotency-key', id('wire-topup-small'))
          .send({ amountMinor: '10000' }),
        'POST /v1/wallets/{id}/top-up (to refund)',
      );
      ok(
        await request(http)
          .post(`/v1/payment-intents/${small.body.paymentIntentId}/refund`)
          .set('authorization', asPlatform())
          .set('idempotency-key', id('wire-intent-refund'))
          .send({ reason: 'wire serialisation sweep' }),
        'POST /v1/payment-intents/{id}/refund',
      );
    });
  });
});
