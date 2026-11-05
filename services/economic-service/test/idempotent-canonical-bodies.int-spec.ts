import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { PrismaClient } from '../src/generated/prisma';
import { zodPipe } from '@rasta/nest-common';
import type { z } from 'zod';
import { hashRequestBody, targeted } from '../src/shared/idempotency';
import {
  cancelTransactionSchema,
  createTransactionSchema,
  disputeTransactionSchema,
  refundTransactionSchema,
  resolveDisputeSchema,
} from '../src/transaction/dto';
import {
  operatorDecisionSchema,
  proposeResolutionSchema,
  refundPaymentSchema,
} from '../src/payment/dto';
import { createParticipationRuleSchema, createRecognitionRuleSchema } from '../src/reward/dto';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ITEST_ACTOR, ownerDatabaseUrl } from './helpers';

/**
 * Every idempotent command but the reward rule's (`reward-rule-canonical`)
 * replays a retry that says the same thing differently (pre-review checklist
 * #16; Codex PR-480 r1, R2, task 129).
 *
 * The body is validated and executed as sent; its canonical form — an amount
 * without leading zeros, an instant as `toISOString`, human text with LF line
 * endings — is hashed beside it (`canonicalBodyPipe`, `shared/canonical.ts`),
 * and what is stored is what the previous release stored (Codex PR-747 r3,
 * F4). Before, each variant below was answered `409
 * IDEMPOTENCY_KEY_REUSED` — never a second effect, but a legitimate retry
 * refused, and for a top-up a client told "another request" may well send a
 * new key and pay twice. A really different body is still 409.
 *
 * And the rollout, both ways: a key stored before this change holds the hash
 * of the body as it was sent, and a key stored by this change still holds that
 * hash — the canonical one beside it — so a retry of that same body replays on
 * either release, and nothing is ever run twice. Nothing is accepted that the
 * previous release refuses.
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

  const storedHashes = (organizationId: string, endpoint: string, key: string) =>
    runUnscoped('the suite reads its key record', () =>
      harness.prisma.client.idempotencyKey.findUniqueOrThrow({
        where: keyRecord(organizationId, endpoint, key),
        select: { requestHash: true, canonicalHash: true },
      }),
    );

  /**
   * What the release before this change stored: the hash of the body as sent,
   * and no canonical hash — it has no such column.
   */
  const storeAsBefore = (organizationId: string, endpoint: string, key: string, body: unknown) =>
    runUnscoped('the suite writes a key record as the previous release did', () =>
      harness.prisma.client.idempotencyKey.update({
        where: keyRecord(organizationId, endpoint, key),
        data: { requestHash: hashRequestBody(body), canonicalHash: null },
      }),
    );

  /**
   * What the release before this change answers the same retry with, from the
   * record this release wrote (Codex PR-747 r2, F3): its claim, line for line —
   * the stored `request_hash` against the hash of `fingerprint`, the body as it
   * validated and wrapped it; the actor binding is the same code in both.
   * A rolling update or a rollback can send the retry there.
   */
  const previousReleaseAnswers = async (
    organizationId: string,
    endpoint: string,
    key: string,
    fingerprint: unknown,
  ) => {
    const existing = await runUnscoped('the suite reads its key record', () =>
      harness.prisma.client.idempotencyKey.findUniqueOrThrow({
        where: keyRecord(organizationId, endpoint, key),
      }),
    );
    if (existing.requestHash !== hashRequestBody(fingerprint)) {
      return { endpoint, answer: '409 IDEMPOTENCY_KEY_REUSED' };
    }
    if (existing.state === 'IN_PROGRESS') return { endpoint, answer: '409 CONFLICT' };
    return { endpoint, answer: `REPLAY ${existing.responseStatus ?? 200}` };
  };

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
    // Stored as the previous release hashes the first request — the bytes a
    // client retries, whichever release the retry reaches (Codex PR-747 r2,
    // F3) — and in canonical form beside it, for every other spelling here.
    expect(await storedHashes(payer, 'POST /v1/wallets/:id/top-up', key)).toEqual({
      requestHash: hashRequestBody(targeted(walletId, { amountMinor: '01000' })),
      canonicalHash: hashRequestBody(targeted(walletId, { amountMinor: '1000' })),
    });
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

  it('dispute, then resolve: CRLF, CR and LF replay; the text is kept as first sent', async () => {
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
    expect(disputed.body).toMatchObject({ status: 'DISPUTED', disputeReason: CRLF });

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
    expect(scored.body).toMatchObject({ label: 'نمونه\r\nنیازمند تصویب' });

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
      levels: [{ name: 'سطح یک\r\nنمونه', threshold: 0 }],
      label: 'نمونه\r\nتصویب',
    });
  });

  // ---- Rollout -----------------------------------------------------------------

  it('a top-up key stored before this change replays its own retry and never runs twice', async () => {
    const key = id('canon-rollout');
    const path = `/v1/wallets/${walletId}/top-up`;
    const endpoint = 'POST /v1/wallets/:id/top-up';
    const first = await post(path, asPayer, key, { amountMinor: '02000' }).expect(201);
    expect(
      await previousReleaseAnswers(
        payer,
        endpoint,
        key,
        targeted(walletId, { amountMinor: '02000' }),
      ),
    ).toEqual({ endpoint, answer: 'REPLAY 201' });
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
    const endpoint = 'POST /v1/transactions/:id/dispute';
    expect(
      await previousReleaseAnswers(payer, endpoint, key, targeted(transactionId, { reason: CRLF })),
    ).toEqual({ endpoint, answer: 'REPLAY 200' });
    await storeAsBefore(payer, endpoint, key, targeted(transactionId, { reason: CRLF }));

    const replayed = await post(path, asPayer, key, { reason: CRLF }).expect(200);
    expect(replayed.body).toEqual(first.body);
    await post(path, asPayer, key, { reason: OTHER }).expect(409);
  });

  // ---- Rollout, at every site (Codex PR-747 r1, F1, F2) ------------------------

  /**
   * What the release before this change validated and hashed: the body
   * through `zodPipe(schema)`, as sent, wrapped as each route of that release
   * wrapped it (`targeted`, the reconciliation's actor binding). Built here
   * from the old shapes, not from the new code's own as-sent form.
   */
  const asSentBefore = (schema: z.ZodType, body: object): unknown =>
    zodPipe(schema).transform(body, { type: 'body' });

  /** The reconciliation's actor binding, as the previous release built it. */
  const boundBefore = (token: string, body: unknown) => {
    const claims = JSON.parse(
      Buffer.from(token.replace(/^Bearer test\./, ''), 'base64url').toString('utf8'),
    ) as { sub: string; rastaUserId: string };
    return {
      by: {
        userId: claims.rastaUserId,
        issuer: process.env.OIDC_ISSUER_URL,
        subject: claims.sub,
      },
      body,
    };
  };

  /**
   * `sent` under a fresh key, and both directions of a rollout:
   *
   *  - new → old (Codex PR-747 r2, F3): the previous release, given the same
   *    bytes, replays the record this release wrote (`fingerprint`, `sent` as
   *    that release validated and wrapped it);
   *  - old → new: the record rewritten as the previous release stored it, the
   *    same bytes again answer the first answer, nothing run twice — and, where
   *    given, `respelt` is still 409, a record stored as sent proving nothing
   *    about another spelling.
   */
  async function storedBefore(options: {
    path: string;
    endpoint: string;
    token: string;
    organizationId?: string;
    status: number;
    sent: object;
    fingerprint: unknown;
    respelt?: object;
  }): Promise<Record<string, unknown>> {
    const { path, endpoint, token, status, sent } = options;
    const organizationId = options.organizationId ?? payer;
    const key = id('canon-before');
    const first = await post(path, token, key, sent).expect(status);
    expect(
      await previousReleaseAnswers(organizationId, endpoint, key, options.fingerprint),
    ).toEqual({ endpoint, answer: `REPLAY ${status}` });
    await storeAsBefore(organizationId, endpoint, key, options.fingerprint);
    const replayed = await post(path, token, key, sent);
    expect({ endpoint, status: replayed.status }).toEqual({ endpoint, status });
    expect(replayed.body).toEqual(first.body);
    if (options.respelt) {
      const refused = await post(path, token, key, options.respelt);
      expect({ endpoint, status: refused.status, code: refused.body.code }).toEqual({
        endpoint,
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    return first.body as Record<string, unknown>;
  }

  it('transaction create, refund, cancel, resolve and payment refund: a pre-change key replays', async () => {
    const create = {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '0750',
      occurredAt: '2026-11-01T10:00:00Z',
    };
    await storedBefore({
      path: '/v1/transactions',
      endpoint: 'POST /v1/transactions',
      token: asPayer,
      status: 201,
      sent: create,
      fingerprint: asSentBefore(createTransactionSchema, create),
      respelt: { ...create, grossAmountMinor: '750' },
    });

    const refundable = await held();
    const refund = { reason: 'returned\r\nbefore dispatch' };
    await storedBefore({
      path: `/v1/transactions/${refundable}/refund`,
      endpoint: 'POST /v1/transactions/:id/refund',
      token: asPayee,
      organizationId: payee,
      status: 200,
      sent: refund,
      fingerprint: targeted(refundable, asSentBefore(refundTransactionSchema, refund)),
      respelt: { reason: 'returned\nbefore dispatch' },
    });

    const cancellable = await post('/v1/transactions', asPayer, id('canon-before-cancel'), {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '800',
    }).expect(201);
    const cancel = { reason: 'with\r\ndrawn' };
    await storedBefore({
      path: `/v1/transactions/${cancellable.body.id as string}/cancel`,
      endpoint: 'POST /v1/transactions/:id/cancel',
      token: asPayer,
      status: 200,
      sent: cancel,
      fingerprint: targeted(
        cancellable.body.id as string,
        asSentBefore(cancelTransactionSchema, cancel),
      ),
      respelt: { reason: 'with\ndrawn' },
    });

    const disputable = await held();
    await post(
      `/v1/transactions/${disputable}/authorise-settlement`,
      asPayer,
      id('canon-before-auth'),
    ).expect(200);
    await post(`/v1/transactions/${disputable}/dispute`, asPayer, id('canon-before-dispute'), {
      reason: LF,
    }).expect(200);
    const resolve = { resolution: 'Settled after\r\nthe call' };
    await storedBefore({
      path: `/v1/transactions/${disputable}/resolve-dispute`,
      endpoint: 'POST /v1/transactions/:id/resolve-dispute',
      token: asUnion,
      status: 200,
      sent: resolve,
      fingerprint: targeted(disputable, asSentBefore(resolveDisputeSchema, resolve)),
      respelt: { resolution: 'Settled after\nthe call' },
    });

    const topUp = await post(`/v1/wallets/${walletId}/top-up`, asPayer, id('canon-before-pay'), {
      amountMinor: '650',
    }).expect(201);
    const intentId = topUp.body.paymentIntentId as string;
    const paymentRefund = { reason: 'customer\r\nasked for it back' };
    await storedBefore({
      path: `/v1/payment-intents/${intentId}/refund`,
      endpoint: 'POST /v1/payment-intents/:id/refund',
      token: asUnion,
      status: 200,
      sent: paymentRefund,
      fingerprint: targeted(intentId, asSentBefore(refundPaymentSchema, paymentRefund)),
      respelt: { reason: 'customer\nasked for it back' },
    });
    const reversals = await runUnscoped('the suite counts the reversals', () =>
      harness.prisma.client.journal.count({ where: { reversesId: topUp.body.journalId } }),
    );
    expect(reversals).toBe(1);
  });

  it('reconciliation requeue, propose, approve and reject: a pre-change key replays through the actor binding', async () => {
    const base = (intentId: string) => `/v1/payment-intents/${intentId}/reconciliation`;
    const endpoint = 'POST /v1/payment-intents/:id/reconciliation';

    const requeueable = await escalated();
    const requeue = { reason: 'The provider\r\nhas its records back' };
    await storedBefore({
      path: `${base(requeueable)}/requeue`,
      endpoint: `${endpoint}/requeue`,
      token: alice,
      status: 200,
      sent: requeue,
      fingerprint: targeted(
        requeueable,
        boundBefore(alice, asSentBefore(operatorDecisionSchema, requeue)),
      ),
      respelt: { reason: 'The provider\nhas its records back' },
    });

    const approvable = await escalated();
    const proposal = {
      providerOutcome: 'DECLINED',
      evidenceReference: 'TICKET-2026-0044',
      reason: 'The statement\r\nshows it declined',
    };
    const proposed = await storedBefore({
      path: `${base(approvable)}/resolutions`,
      endpoint: `${endpoint}/resolutions`,
      token: alice,
      status: 200,
      sent: proposal,
      fingerprint: targeted(
        approvable,
        boundBefore(alice, asSentBefore(proposeResolutionSchema, proposal)),
      ),
      respelt: { ...proposal, reason: 'The statement\nshows it declined' },
    });
    const resolutionId = proposed.id as string;
    const approve = { reason: 'Checked\r\nagainst the ticket' };
    const approved = await storedBefore({
      path: `${base(approvable)}/resolutions/${resolutionId}/approve`,
      endpoint: `${endpoint}/resolutions/:resolutionId/approve`,
      token: bob,
      status: 200,
      sent: approve,
      fingerprint: targeted(
        `${approvable}/${resolutionId}`,
        boundBefore(bob, asSentBefore(operatorDecisionSchema, approve)),
      ),
      respelt: { reason: 'Checked\nagainst the ticket' },
    });
    expect(approved).toMatchObject({ status: 'APPROVED' });

    const rejectable = await escalated();
    const second = await post(`${base(rejectable)}/resolutions`, alice, id('canon-before-p2'), {
      ...proposal,
      reason: 'The statement shows it declined',
    }).expect(200);
    const secondId = second.body.id as string;
    const reject = { reason: 'For another\r\npayment' };
    const rejected = await storedBefore({
      path: `${base(rejectable)}/resolutions/${secondId}/reject`,
      endpoint: `${endpoint}/resolutions/:resolutionId/reject`,
      token: bob,
      status: 200,
      sent: reject,
      fingerprint: targeted(
        `${rejectable}/${secondId}`,
        boundBefore(bob, asSentBefore(operatorDecisionSchema, reject)),
      ),
      respelt: { reason: 'For another\npayment' },
    });
    expect(rejected).toMatchObject({ status: 'REJECTED' });
  });

  const currentVersion = async (path: string) => {
    const listed = await request(http).get(path).set('authorization', asRuleAdmin).expect(200);
    return (listed.body.items[0]?.version as number | undefined) ?? 0;
  };

  it('participation and recognition versions: a pre-change key replays', async () => {
    const participation = {
      expectedCurrentVersion: await currentVersion('/v1/rewards/participation-rules'),
      windowDays: 30,
      contributions: [{ triggerEvent: 'USAGE_RECORDED', weight: 2 }],
      label: 'نمونه\r\nپیش از تغییر',
    };
    await storedBefore({
      path: '/v1/rewards/participation-rules',
      endpoint: 'POST /v1/rewards/participation-rules',
      token: asRuleAdmin,
      status: 201,
      sent: participation,
      fingerprint: asSentBefore(createParticipationRuleSchema, participation),
      respelt: { ...participation, label: 'نمونه\nپیش از تغییر' },
    });

    const recognition = {
      expectedCurrentVersion: await currentVersion('/v1/rewards/recognition-rules'),
      basis: 'REWARD_POINTS_CUMULATIVE',
      levels: [{ name: 'سطح\r\nپیش از تغییر', threshold: 0 }],
      badges: [],
    };
    await storedBefore({
      path: '/v1/rewards/recognition-rules',
      endpoint: 'POST /v1/rewards/recognition-rules',
      token: asRuleAdmin,
      status: 201,
      sent: recognition,
      fingerprint: asSentBefore(createRecognitionRuleSchema, recognition),
      respelt: { ...recognition, levels: [{ name: 'سطح\nپیش از تغییر', threshold: 0 }] },
    });
  });

  // Ten UTF-16 units as sent — the minimum both this service and marketplace
  // check — and nine once LF: the previous release, and marketplace still,
  // accept it; its canonical form is refused.
  const SHORT = '1234\r\n5678';

  it('a dispute and its resolution the previous release accepted, canonical form refused: executed, and a pre-change key replays', async () => {
    const transactionId = await held();
    await post(
      `/v1/transactions/${transactionId}/authorise-settlement`,
      asPayer,
      id('canon-short-auth'),
    ).expect(200);
    // As marketplace forwards a dispute it has committed: not a new 400.
    const disputed = await storedBefore({
      path: `/v1/transactions/${transactionId}/dispute`,
      endpoint: 'POST /v1/transactions/:id/dispute',
      token: asPayer,
      status: 200,
      sent: { reason: SHORT },
      fingerprint: targeted(
        transactionId,
        asSentBefore(disputeTransactionSchema, { reason: SHORT }),
      ),
    });
    // Kept as sent, as before; marketplace compares it line-ending-blind.
    expect(disputed).toMatchObject({ status: 'DISPUTED', disputeReason: SHORT });
    // Its LF spelling is the canonical form, still refused.
    await post(`/v1/transactions/${transactionId}/dispute`, asPayer, id('canon-short-lf'), {
      reason: '1234\n5678',
    }).expect(400);

    const resolved = await storedBefore({
      path: `/v1/transactions/${transactionId}/resolve-dispute`,
      endpoint: 'POST /v1/transactions/:id/resolve-dispute',
      token: asUnion,
      status: 200,
      sent: { resolution: SHORT, disputeId: disputed.disputeId as string },
      fingerprint: targeted(
        transactionId,
        asSentBefore(resolveDisputeSchema, {
          resolution: SHORT,
          disputeId: disputed.disputeId as string,
        }),
      ),
    });
    expect(resolved).toMatchObject({ status: 'PENDING_SETTLEMENT', disputeResolution: SHORT });
  });

  it('a recognition version whose level names differ only in line endings: executed as sent, and a pre-change key replays', async () => {
    const recognition = {
      expectedCurrentVersion: await currentVersion('/v1/rewards/recognition-rules'),
      basis: 'REWARD_POINTS_CUMULATIVE',
      levels: [
        { name: 'first\r\nsecond', threshold: 0 },
        { name: 'first\nsecond', threshold: 5 },
      ],
      badges: [],
    };
    const created = await storedBefore({
      path: '/v1/rewards/recognition-rules',
      endpoint: 'POST /v1/rewards/recognition-rules',
      token: asRuleAdmin,
      status: 201,
      sent: recognition,
      fingerprint: asSentBefore(createRecognitionRuleSchema, recognition),
    });
    expect(created).toMatchObject({ levels: recognition.levels });
  });
  // ---- Validation, both directions (Codex PR-747 r2, F3) ------------------------

  it('a text over its limit as sent, within it once LF, is refused as the previous release refuses it', async () => {
    const transactionId = await held();
    await post(
      `/v1/transactions/${transactionId}/authorise-settlement`,
      asPayer,
      id('canon-long-auth'),
    ).expect(200);
    // 1 201 UTF-16 units as sent, over the 1 000 limit; 801 once LF. Accepted
    // here, its retry would be a 400 on the previous release — and on this one
    // after a rollback.
    const reason = `${'a\r\n'.repeat(400)}x`;
    expect(reason.replace(/\r\n/g, '\n')).toHaveLength(801);
    let before: unknown;
    try {
      asSentBefore(disputeTransactionSchema, { reason });
    } catch (error) {
      before = error;
    }
    expect(before).toMatchObject({ code: 'VALIDATION_FAILED' });
    const refused = await post(
      `/v1/transactions/${transactionId}/dispute`,
      asPayer,
      id('canon-long'),
      { reason },
    ).expect(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: (before as { details: unknown }).details,
    });
    const detail = await request(http)
      .get(`/v1/transactions/${transactionId}`)
      .set('authorization', asPayer)
      .expect(200);
    expect(detail.body.status).not.toBe('DISPUTED');
  });
});
