import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { RefundRequest, RefundResult } from '../src/payment/provider';
import { admin, apiTenant, auditor, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * The operator path over HTTP (ADR-064 § 6, step B3): the routes, their
 * validation (evidence is mandatory and pattern-checked, Q-82), the
 * `Idempotency-Key`, the role ceiling, AUDITOR's refusal and tenant
 * isolation. The domain rules themselves — four-eyes, separation, what an
 * approval moves — are `payment-reconciliation-operator.int-spec.ts`.
 */
describe('payment reconciliation operator routes (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('RECON-OP');
  const other = apiTenant('RECON-OP-OTHER');
  const creator = admin(org);
  const refunder = admin(org, ['UNION_ADMIN']);
  const alice = admin(org, ['SYSTEM_ADMIN']);
  const bob = admin(org, ['SYSTEM_ADMIN']);
  const mallory = admin(other, ['SYSTEM_ADMIN']);

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

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: provider });
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org, other]);
    await harness.close();
  });

  const as = (token: string) => `Bearer ${token}`;
  const base = (intentId: string) => `/v1/payment-intents/${intentId}/reconciliation`;

  /** A top-up whose refund answer was lost, its task escalated to a person. */
  async function escalated(): Promise<string> {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', as(creator))
      .expect(200);
    const topUp = await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', as(creator))
      .set('idempotency-key', id('recon-op-topup'))
      .send({ amountMinor: '700' })
      .expect(201);
    const intentId = topUp.body.paymentIntentId as string;
    provider.loseNextRefund = true;
    await request(http)
      .post(`/v1/payment-intents/${intentId}/refund`)
      .set('authorization', as(refunder))
      .set('idempotency-key', id('recon-op-refund'))
      .send({ reason: 'customer asked for it back' });
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

  const proposal = {
    providerOutcome: 'DECLINED',
    evidenceReference: 'TICKET-2026-0042',
    reason: 'The provider statement shows the refund declined',
  };

  it('proposes and approves through the routes, idempotently, naming both actors', async () => {
    const intentId = await escalated();
    const key = id('recon-op-propose');
    const proposed = await request(http)
      .post(`${base(intentId)}/resolutions`)
      .set('authorization', as(alice))
      .set('idempotency-key', key)
      .send(proposal)
      .expect(200);
    expect(proposed.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      providerOutcome: 'DECLINED',
      evidenceReference: 'TICKET-2026-0042',
      fourEyes: true,
      decidedBy: null,
    });

    // Same key, same body: the same answer, and no second proposal.
    const replayed = await request(http)
      .post(`${base(intentId)}/resolutions`)
      .set('authorization', as(alice))
      .set('idempotency-key', key)
      .send(proposal)
      .expect(200);
    expect(replayed.body.id).toBe(proposed.body.id);

    // The proposer cannot approve their own.
    await request(http)
      .post(`${base(intentId)}/resolutions/${proposed.body.id}/approve`)
      .set('authorization', as(alice))
      .set('idempotency-key', id('recon-op-self'))
      .send({ reason: 'Approving my own' })
      .expect(403);

    const approved = await request(http)
      .post(`${base(intentId)}/resolutions/${proposed.body.id}/approve`)
      .set('authorization', as(bob))
      .set('idempotency-key', id('recon-op-approve'))
      .send({ reason: 'Checked the statement against the ticket' })
      .expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED' });
    expect(approved.body.decidedBy).not.toBe(proposed.body.proposedBy);

    const view = await request(http).get(base(intentId)).set('authorization', as(bob)).expect(200);
    expect(view.body).toMatchObject({
      paymentIntentId: intentId,
      failureReason: null,
      task: { status: 'DONE', resolution: 'REFUND_DECLINED' },
      resolutions: [{ id: proposed.body.id, status: 'APPROVED' }],
    });
  });

  it('requeues an escalated task, and rejects a proposal', async () => {
    const intentId = await escalated();
    const requeued = await request(http)
      .post(`${base(intentId)}/requeue`)
      .set('authorization', as(alice))
      .set('idempotency-key', id('recon-op-requeue'))
      .send({ reason: 'The provider has its records back' })
      .expect(200);
    expect(requeued.body).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      lastOutcome: 'REQUEUED',
    });

    const proposed = await request(http)
      .post(`${base(intentId)}/resolutions`)
      .set('authorization', as(alice))
      .set('idempotency-key', id('recon-op-p2'))
      .send(proposal)
      .expect(200);
    const rejected = await request(http)
      .post(`${base(intentId)}/resolutions/${proposed.body.id}/reject`)
      .set('authorization', as(bob))
      .set('idempotency-key', id('recon-op-reject'))
      .send({ reason: 'The statement is for another payment' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED' });
  });

  it('refuses a proposal without evidence, with free-text evidence, or without a key', async () => {
    const intentId = await escalated();
    for (const body of [
      { providerOutcome: 'DECLINED', reason: 'no evidence given' },
      { ...proposal, evidenceReference: 'see the attached statement' },
      { ...proposal, evidenceReference: '' },
      { ...proposal, providerOutcome: 'MAYBE' },
      { ...proposal, reason: '' },
      { ...proposal, extra: 'field' },
    ]) {
      const refused = await request(http)
        .post(`${base(intentId)}/resolutions`)
        .set('authorization', as(alice))
        .set('idempotency-key', id('recon-op-bad'))
        .send(body)
        .expect(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    }
    await request(http)
      .post(`${base(intentId)}/resolutions`)
      .set('authorization', as(alice))
      .send(proposal)
      .expect(400);
    await request(http)
      .post(`${base(intentId)}/requeue`)
      .set('authorization', as(alice))
      .send({ reason: 'no key' })
      .expect(400);
  });

  it('refuses AUDITOR and a role below the ceiling, and answers 404 across tenants', async () => {
    const intentId = await escalated();
    for (const token of [auditor(org), admin(org, ['ORGANIZATION_ADMIN'])]) {
      await request(http).get(base(intentId)).set('authorization', as(token)).expect(403);
      await request(http)
        .post(`${base(intentId)}/resolutions`)
        .set('authorization', as(token))
        .set('idempotency-key', id('recon-op-role'))
        .send(proposal)
        .expect(403);
    }

    await request(http).get(base(intentId)).set('authorization', as(mallory)).expect(404);
    await request(http)
      .post(`${base(intentId)}/resolutions`)
      .set('authorization', as(mallory))
      .set('idempotency-key', id('recon-op-iso'))
      .send(proposal)
      .expect(404);
    await request(http)
      .post(`${base(intentId)}/requeue`)
      .set('authorization', as(mallory))
      .set('idempotency-key', id('recon-op-iso-rq'))
      .send({ reason: 'Across tenants' })
      .expect(404);
  });
});
