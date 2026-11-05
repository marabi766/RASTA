import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { PrismaClient } from '../src/generated/prisma';
import { hashRequestBody, targeted } from '../src/shared/idempotency';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ITEST_ACTOR, ownerDatabaseUrl } from './helpers';

/**
 * Every idempotent command but the reward rule's (`reward-rule-canonical`)
 * replays a retry that says the same thing differently (pre-review checklist
 * #16; Codex PR-480 r1, R2, task 129).
 *
 * The body is put in canonical form before it is validated, hashed and
 * executed (`canonicalBodyPipe`, `shared/canonical.ts`): an amount without
 * leading zeros, an instant as `toISOString`, human text with LF line
 * endings. Before, each variant below was answered `409
 * IDEMPOTENCY_KEY_REUSED` — never a second effect, but a legitimate retry
 * refused, and for a top-up a client told "another request" may well send a
 * new key and pay twice. A really different body is still 409.
 *
 * And the rollout: a key stored before this change holds the hash of the
 * body as it was sent. A retry of that same body still replays it (the
 * store also compares the as-sent form), and nothing is ever run twice.
 */
describe('idempotent commands, canonical before they are hashed (real HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  /** A provider whose refund takes effect and whose answer is then lost. */
  class LosingRefundProvider extends MockPaymentProvider {
    loseNextRefund = false;

    override async refund(refund: RefundRequest): Promise<RefundResult> {
      const answer = await super.refund(refund);
      if (this.loseNextRefund) {
        this.loseNextRefund = false;
        throw new Error('provider response lost');
      }
      return answer;
    }
  }
  const provider = new LosingRefundProvider();

  const payer = apiTenant('CANON-PAYER');
  const payee = apiTenant('CANON-PAYEE');
  const asPayer = `Bearer ${admin(payer)}`;
  const asPayee = `Bearer ${admin(payee)}`;
  const asUnion = `Bearer ${admin(payer, ['UNION_ADMIN'])}`;
  const alice = `Bearer ${admin(payer, ['SYSTEM_ADMIN'], 'alice')}`;
  const bob = `Bearer ${admin(payer, ['SYSTEM_ADMIN'], 'bob')}`;
  const RULE_ADMIN = `${ITEST_ACTOR}-CANON-RULES`;
  const asRuleAdmin = `Bearer ${bearer({
    sub: `sub-${RULE_ADMIN}`,
    rastaUserId: RULE_ADMIN,
    organizationId: payer,
    organizationIds: [payer],
    roles: ['SYSTEM_ADMIN'],
  })}`;

  let walletId: string;

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: provider });
    http = harness.app.getHttpServer() as Server;
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', asPayer)
      .expect(200);
    walletId = wallet.body.id as string;
    await post(`/v1/wallets/${walletId}/top-up`, asPayer, id('canon-fund'), {
      amountMinor: '10000000',
    }).expect(201);
    await request(http).get('/v1/wallets/me').set('authorization', asPayee).expect(200);
  });

  afterAll(async () => {
    // Platform-wide, append-only: only the owner, with the guards lifted
    // inside one transaction, removes this run's versions (recognition.int-spec).
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      await owner.$transaction(async (tx) => {
        for (const [table, trigger] of [
          ['recognition_rule', 'trg_recognition_rule_append_only'],
          ['participation_rule', 'trg_participation_rule_append_only'],
        ] as const) {
          // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; bounded by this transaction.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE created_by = $1`, RULE_ADMIN);
          // ISOLATION-ALLOW-UNBOUNDED: as above.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
      });
    } finally {
      await owner.$disconnect();
    }
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  function post(path: string, token: string, key: string, body?: object): request.Test {
    const sent = request(http).post(path).set('authorization', token).set('idempotency-key', key);
    return body === undefined ? sent : sent.send(body);
  }

  /**
   * `first` under a fresh key; then each of `variants` — the same request,
   * spelt differently — under the same key answers exactly the first answer;
   * then each of `different` is 409 `IDEMPOTENCY_KEY_REUSED`.
   */
  async function equivalent(
    path: string,
    token: string,
    status: number,
    first: object,
    variants: object[],
    different: object[],
  ): Promise<{ key: string; body: Record<string, unknown> }> {
    const key = id('canon');
    const answered = await post(path, token, key, first).expect(status);
    for (const variant of variants) {
      const replayed = await post(path, token, key, variant);
      expect({ variant, status: replayed.status }).toEqual({ variant, status });
      expect(replayed.body).toEqual(answered.body);
    }
    for (const body of different) {
      const refused = await post(path, token, key, body);
      expect({ body, status: refused.status, code: refused.body.code }).toEqual({
        body,
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return { key, body: answered.body as Record<string, unknown> };
  }

  const intentsUnder = (key: string) =>
    runUnscoped('the suite counts its payment intents', () =>
      harness.prisma.client.paymentIntent.count({
        where: { organizationId: payer, idempotencyKey: key },
      }),
    );

  const transactionsUnder = (key: string) =>
    runUnscoped('the suite counts its transactions', () =>
      harness.prisma.client.transaction.count({
        where: { organizationId: payer, idempotencyKey: key },
      }),
    );

  const keyRecord = (organizationId: string, endpoint: string, key: string) => ({
    organizationId_endpoint_key: { organizationId, endpoint, key },
  });

  const storedHash = async (organizationId: string, endpoint: string, key: string) =>
    (
      await runUnscoped('the suite reads its key record', () =>
        harness.prisma.client.idempotencyKey.findUniqueOrThrow({
          where: keyRecord(organizationId, endpoint, key),
          select: { requestHash: true },
        }),
      )
    ).requestHash;

  /** What the release before this change stored: the hash of the body as sent. */
  const storeAsBefore = (organizationId: string, endpoint: string, key: string, body: unknown) =>
    runUnscoped('the suite writes a key record as the previous release did', () =>
      harness.prisma.client.idempotencyKey.update({
        where: keyRecord(organizationId, endpoint, key),
        data: { requestHash: hashRequestBody(body) },
      }),
    );

  /** A held, authorised LOGISTICS obligation of the payer's to the payee. */
  async function held(amountMinor = '900'): Promise<string> {
    const created = await post('/v1/transactions', asPayer, id('canon-txn'), {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: payee,
      grossAmountMinor: amountMinor,
      holdFunds: true,
    }).expect(201);
    return created.body.id as string;
  }

  /** A top-up whose refund answer was lost, its task escalated to a person. */
  async function escalated(): Promise<string> {
    const topUp = await post(`/v1/wallets/${walletId}/top-up`, asPayer, id('canon-recon'), {
      amountMinor: '700',
    }).expect(201);
    const intentId = topUp.body.paymentIntentId as string;
    provider.loseNextRefund = true;
    await post(`/v1/payment-intents/${intentId}/refund`, asUnion, id('canon-recon-refund'), {
      reason: 'customer asked for it back',
    });
    await runUnscoped('the suite escalates the task', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task
            SET status = 'ESCALATED', escalated_at = now(), last_outcome = 'PROVIDER_OUTCOME_UNKNOWN'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        intentId,
      ),
    );
    return intentId;
  }

  // ---- Amounts ---------------------------------------------------------------

  it('top-up: leading zeros replay the one intent; another amount is 409', async () => {
    const { key } = await equivalent(
      `/v1/wallets/${walletId}/top-up`,
      asPayer,
      201,
      { amountMinor: '01000' },
      [{ amountMinor: '1000' }, { amountMinor: '0001000' }],
      [{ amountMinor: '1001' }, { amountMinor: '1000', instrument: 'ok' }],
    );
    expect(await intentsUnder(key)).toBe(1);
    // Stored in the one form, so a release without the as-sent comparison —
    // a rollback — still replays every canonical retry.
    expect(await storedHash(payer, 'POST /v1/wallets/:id/top-up', key)).toBe(
      hashRequestBody(targeted(walletId, { amountMinor: '1000' })),
    );
  });

  it('transaction create: amount and instant spellings replay; omitted, another value is 409', async () => {
    const body = {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: payee,
      holdFunds: false,
    };
    const { key, body: answer } = await equivalent(
      '/v1/transactions',
      asPayer,
      201,
      { ...body, grossAmountMinor: '0700', occurredAt: '2026-11-01T10:00:00Z' },
      [
        { ...body, grossAmountMinor: '700', occurredAt: '2026-11-01T10:00:00.000Z' },
        { ...body, grossAmountMinor: '00700', occurredAt: '2026-11-01T10:00:00.0Z' },
      ],
      [
        { ...body, grossAmountMinor: '701', occurredAt: '2026-11-01T10:00:00Z' },
        { ...body, grossAmountMinor: '700', occurredAt: '2026-11-01T10:00:01Z' },
        // Omitted is not the instant it would default to.
        { ...body, grossAmountMinor: '700' },
      ],
    );
    expect(answer).toMatchObject({ grossAmountMinor: '700' });
    expect(await transactionsUnder(key)).toBe(1);
  });

  // ---- Human text --------------------------------------------------------------

  const CRLF = 'The delivered quantity\r\ndoes not match the obligation.';
  const LF = 'The delivered quantity\ndoes not match the obligation.';
  const CR = 'The delivered quantity\rdoes not match the obligation.';
  const OTHER = 'The delivered quantity does not match the obligation.';

  it('dispute, then resolve: CRLF, CR and LF replay; the text is executed as LF', async () => {
    const transactionId = await held();
    await post(
      `/v1/transactions/${transactionId}/authorise-settlement`,
      asPayer,
      id('canon-auth'),
    ).expect(200);
    const disputed = await equivalent(
      `/v1/transactions/${transactionId}/dispute`,
      asPayer,
      200,
      { reason: CRLF },
      [{ reason: LF }, { reason: CR }],
      [{ reason: OTHER }],
    );
    expect(disputed.body).toMatchObject({ status: 'DISPUTED', disputeReason: LF });

    const resolved = await equivalent(
      `/v1/transactions/${transactionId}/resolve-dispute`,
      asUnion,
      200,
      { resolution: LF },
      [{ resolution: CRLF }, { resolution: CR }],
      [{ resolution: OTHER }],
    );
    expect(resolved.body).toMatchObject({ status: 'PENDING_SETTLEMENT', disputeResolution: LF });
  });

  it('transaction refund and cancel: line-ending spellings replay', async () => {
    const refundable = await held();
    const refunded = await equivalent(
      `/v1/transactions/${refundable}/refund`,
      asPayee,
      200,
      { reason: 'returned\r\nbefore dispatch' },
      [{ reason: 'returned\nbefore dispatch' }],
      [{ reason: 'returned before dispatch' }],
    );
    expect(refunded.body).toMatchObject({ status: 'REFUNDED' });

    const created = await post('/v1/transactions', asPayer, id('canon-cancel'), {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '800',
    }).expect(201);
    const cancelled = await equivalent(
      `/v1/transactions/${created.body.id as string}/cancel`,
      asPayer,
      200,
      { reason: 'with\r\ndrawn' },
      [{ reason: 'with\ndrawn' }, { reason: 'with\rdrawn' }],
      [{ reason: 'with drawn' }],
    );
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED' });
  });

  it('payment refund: line-ending spellings replay the one refund', async () => {
    const topUp = await post(`/v1/wallets/${walletId}/top-up`, asPayer, id('canon-pay'), {
      amountMinor: '600',
    }).expect(201);
    const refunded = await equivalent(
      `/v1/payment-intents/${topUp.body.paymentIntentId as string}/refund`,
      asUnion,
      200,
      { reason: 'customer\r\nasked for it back' },
      [{ reason: 'customer\nasked for it back' }],
      [{ reason: 'customer asked for it back' }],
    );
    expect(refunded.body).toMatchObject({
      paymentIntentId: topUp.body.paymentIntentId,
      reversalJournalId: expect.any(String),
    });
    // One refund, one reversal.
    const reversals = await runUnscoped('the suite counts the reversals', () =>
      harness.prisma.client.journal.count({ where: { reversesId: topUp.body.journalId } }),
    );
    expect(reversals).toBe(1);
  });

  it('reconciliation requeue, propose, approve and reject: line-ending spellings replay', async () => {
    const base = (intentId: string) => `/v1/payment-intents/${intentId}/reconciliation`;
    const requeueable = await escalated();
    const requeued = await equivalent(
      `${base(requeueable)}/requeue`,
      alice,
      200,
      { reason: 'The provider\r\nhas its records back' },
      [{ reason: 'The provider\nhas its records back' }],
      [{ reason: 'The provider has its records back' }],
    );
    expect(requeued.body).toMatchObject({ status: 'PENDING', lastOutcome: 'REQUEUED' });

    const proposal = {
      providerOutcome: 'DECLINED',
      evidenceReference: 'TICKET-2026-0042',
    };
    const approvable = await escalated();
    const proposed = await equivalent(
      `${base(approvable)}/resolutions`,
      alice,
      200,
      { ...proposal, reason: 'The statement\r\nshows it declined' },
      [{ ...proposal, reason: 'The statement\nshows it declined' }],
      [
        { ...proposal, reason: 'The statement shows it declined' },
        {
          ...proposal,
          evidenceReference: 'TICKET-2026-0043',
          reason: 'The statement\nshows it declined',
        },
      ],
    );
    const approved = await equivalent(
      `${base(approvable)}/resolutions/${proposed.body.id as string}/approve`,
      bob,
      200,
      { reason: 'Checked\r\nagainst the ticket' },
      [{ reason: 'Checked\nagainst the ticket' }],
      [{ reason: 'Checked against the ticket' }],
    );
    expect(approved.body).toMatchObject({ status: 'APPROVED' });

    const rejectable = await escalated();
    const second = await post(`${base(rejectable)}/resolutions`, alice, id('canon-p2'), {
      ...proposal,
      reason: 'The statement shows it declined',
    }).expect(200);
    const rejected = await equivalent(
      `${base(rejectable)}/resolutions/${second.body.id as string}/reject`,
      bob,
      200,
      { reason: 'For another\r\npayment' },
      [{ reason: 'For another\npayment' }],
      [{ reason: 'For another payment' }],
    );
    expect(rejected.body).toMatchObject({ status: 'REJECTED' });
  });

  it('participation and recognition versions: line-ending spellings replay, nested names included', async () => {
    const current = async (path: string) => {
      const listed = await request(http).get(path).set('authorization', asRuleAdmin).expect(200);
      return (listed.body.items[0]?.version as number | undefined) ?? 0;
    };

    const participation = {
      expectedCurrentVersion: await current('/v1/rewards/participation-rules'),
      windowDays: 30,
      contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 2 }],
    };
    const scored = await equivalent(
      '/v1/rewards/participation-rules',
      asRuleAdmin,
      201,
      { ...participation, label: 'نمونه\r\nنیازمند تصویب' },
      [{ ...participation, label: 'نمونه\nنیازمند تصویب' }],
      [
        { ...participation, label: 'نمونه نیازمند تصویب' },
        { ...participation, windowDays: 31 },
      ],
    );
    expect(scored.body).toMatchObject({ label: 'نمونه\nنیازمند تصویب' });

    const recognition = {
      expectedCurrentVersion: await current('/v1/rewards/recognition-rules'),
      basis: 'REWARD_POINTS_CUMULATIVE',
      badges: [],
    };
    const level = (name: string) => [{ name, threshold: 0 }];
    const ranked = await equivalent(
      '/v1/rewards/recognition-rules',
      asRuleAdmin,
      201,
      { ...recognition, levels: level('سطح یک\r\nنمونه'), label: 'نمونه\r\nتصویب' },
      [{ ...recognition, levels: level('سطح یک\nنمونه'), label: 'نمونه\rتصویب' }],
      [{ ...recognition, levels: level('سطح یک نمونه'), label: 'نمونه\nتصویب' }],
    );
    expect(ranked.body).toMatchObject({
      levels: [{ name: 'سطح یک\nنمونه', threshold: 0 }],
      label: 'نمونه\nتصویب',
    });
  });

  // ---- Rollout -----------------------------------------------------------------

  it('a top-up key stored before this change replays its own retry and never runs twice', async () => {
    const key = id('canon-rollout');
    const path = `/v1/wallets/${walletId}/top-up`;
    const endpoint = 'POST /v1/wallets/:id/top-up';
    const first = await post(path, asPayer, key, { amountMinor: '02000' }).expect(201);
    await storeAsBefore(payer, endpoint, key, targeted(walletId, { amountMinor: '02000' }));

    // The retry the client was always going to send: the same bytes.
    const replayed = await post(path, asPayer, key, { amountMinor: '02000' }).expect(201);
    expect(replayed.body).toEqual(first.body);
    // Another spelling of a record stored as sent cannot be proven the same
    // request from its hash: refused, as before — never a second top-up.
    const respelt = await post(path, asPayer, key, { amountMinor: '2000' }).expect(409);
    expect(respelt.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await post(path, asPayer, key, { amountMinor: '2001' }).expect(409);
    expect(await intentsUnder(key)).toBe(1);
  });

  it('a dispute key stored before this change replays its own CRLF retry', async () => {
    const transactionId = await held();
    await post(
      `/v1/transactions/${transactionId}/authorise-settlement`,
      asPayer,
      id('canon-rollout-auth'),
    ).expect(200);
    const key = id('canon-rollout-dispute');
    const path = `/v1/transactions/${transactionId}/dispute`;
    const first = await post(path, asPayer, key, { reason: CRLF }).expect(200);
    await storeAsBefore(
      payer,
      'POST /v1/transactions/:id/dispute',
      key,
      targeted(transactionId, { reason: CRLF }),
    );

    const replayed = await post(path, asPayer, key, { reason: CRLF }).expect(200);
    expect(replayed.body).toEqual(first.body);
    await post(path, asPayer, key, { reason: OTHER }).expect(409);
  });
});
