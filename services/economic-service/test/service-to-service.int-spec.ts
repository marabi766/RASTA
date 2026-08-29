import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * Zero Trust between services, with a signed tenant (ADR-020, ADR-035).
 *
 * Every other scenario in this suite arrives as a person. This one arrives as
 * a **service**, which is how `docs/08` § 8.6 says the order saga reaches this
 * domain: `OrderSagaWorkflow` calls `placeHold()` and `settle()` as
 * activities, not as events.
 *
 * The property under test is narrow and absolute: **the tenant comes from the
 * signature, never from a header.** An unsigned `X-Organization-Id` can be
 * written by anything that reaches this service, so honouring it would turn a
 * leaked internal token from "impersonate marketplace-service" into "move
 * money for any organization on the platform".
 *
 * This file previously asserted the opposite — that a service call could not
 * resolve a tenant at all and died with a 500. That was the defect Q-28
 * recorded, and every one of those assertions is now inverted.
 */
describe('service-to-service access', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('S2S-PAYER');
  const payee = apiTenant('S2S-PAYEE');
  const stranger = apiTenant('S2S-STRANGER');

  /** A token bound to one organization and to this service. */
  const forTenant = (organizationId: string, caller = 'marketplace-service') =>
    internalToken(caller, { organizationId });

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('s2s-fund'))
      .send({ amountMinor: '30000000' })
      .expect(201);

    for (const org of [payee, stranger]) {
      await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(org)}`)
        .expect(200);
    }
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, stranger]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // The tenant comes from the signature
  // -------------------------------------------------------------------------

  it('serves a permitted service the organization its token was signed for', async () => {
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', await forTenant(payer))
      .expect(200);

    expect(response.body.organizationId).toBe(payer);
  });

  it('accepts a header that agrees with the signed claim', async () => {
    // The header still travels — the gateway and the calling service both
    // propagate it — but it may only agree.
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', await forTenant(payer))
      .set('x-organization-id', payer)
      .expect(200);

    expect(response.body.organizationId).toBe(payer);
  });

  it('refuses a header that disagrees with the signed claim', async () => {
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', await forTenant(payer))
      .set('x-organization-id', payee)
      .expect(403);

    expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
  });

  it('never lets a forged header reach another tenant’s money', async () => {
    // The attack ADR-035 exists to stop, asserted on a read and on a write.
    const token = await forTenant(payer);

    const read = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', token)
      .set('x-organization-id', payee)
      .expect(403);
    // Nothing about the other organization comes back — not a balance, not an
    // id, not a confirmation that it exists.
    expect(JSON.stringify(read.body)).not.toContain(payee);

    const write = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set('x-organization-id', payee)
      .set('idempotency-key', id('s2s-forged'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: stranger,
        grossAmountMinor: '5000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(403);
    expect(write.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');

    // And the payee's wallet is untouched: no hold, no balance change.
    const payeeWallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
    expect(BigInt(payeeWallet.body.pendingBalanceMinor)).toBe(0n);
  });

  it('refuses a claim-less token on a tenant-scoped endpoint, as 403 and not 500', async () => {
    // The whole point of the repair. This path used to raise a raw Error from
    // `getOrganizationId()` and surface as `500 INTERNAL_ERROR`, which made a
    // deliberate security rule look like a fault.
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', await internalToken('marketplace-service'))
      .expect(403);

    expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    // The response says nothing about which check failed, or about the token.
    expect(JSON.stringify(response.body)).not.toContain('MISSING_CLAIM');
    expect(JSON.stringify(response.body)).not.toContain('marketplace-service');
  });

  it('writes nothing when the token carries no tenant', async () => {
    const reference = id('s2s-claimless');

    await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await internalToken('marketplace-service'))
      .set('idempotency-key', reference)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '150000',
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(403);

    const listed = await request(http)
      .get(`/v1/transactions?sourceReference=${encodeURIComponent(reference)}`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    expect(listed.body.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation, from a service caller
  // -------------------------------------------------------------------------

  it('cannot read another tenant’s record even with a valid token of its own', async () => {
    // A transaction that belongs to `payer`, read with a token signed for
    // `stranger`. The object-access contract answers 404, never 403: a 403
    // would confirm the record exists.
    const key = id('s2s-isolation');
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await forTenant(payer))
      .set('idempotency-key', key)
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '4000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: key,
        holdFunds: false,
      })
      .expect(201);

    const refused = await request(http)
      .get(`/v1/transactions/${created.body.id}`)
      .set('x-internal-token', await forTenant(stranger))
      .expect(404);
    expect(refused.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(refused.body)).not.toContain(payer);

    // And it cannot mutate it either.
    await request(http)
      .post(`/v1/transactions/${created.body.id}/cancel`)
      .set('x-internal-token', await forTenant(stranger))
      .set('idempotency-key', id('s2s-isolation-cancel'))
      .send({ reason: 'attempted from another tenant' })
      .expect(404);

    // The row is untouched.
    const still = await request(http)
      .get(`/v1/transactions/${created.body.id}`)
      .set('x-internal-token', await forTenant(payer))
      .expect(200);
    expect(still.body.status).toBe('CREATED');
  });

  // -------------------------------------------------------------------------
  // Everything ADR-020 already required
  // -------------------------------------------------------------------------

  it('refuses a token minted for a different service', async () => {
    await request(http)
      .get('/v1/wallets/me')
      .set(
        'x-internal-token',
        await internalToken('marketplace-service', {
          organizationId: payer,
          targetService: 'notification-service',
        }),
      )
      .expect(401);
  });

  it('refuses an expired token', async () => {
    const token = await internalToken('marketplace-service', {
      organizationId: payer,
      ttlSeconds: 30,
    });

    // `jest.setSystemTime` rather than stubbing `Date.now`: jose reads the
    // clock through `new Date()`, so replacing only the static method leaves
    // the token looking fresh and the test passing for no reason.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(Date.now() + 120_000);
    try {
      await request(http).get('/v1/wallets/me').set('x-internal-token', token).expect(401);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a malformed token', async () => {
    await request(http).get('/v1/wallets/me').set('x-internal-token', 'not-a-token').expect(401);
  });

  it('refuses a service the endpoint does not name', async () => {
    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', await forTenant(payer, 'notification-service'))
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('refuses every service an endpoint that names none', async () => {
    // Changing a commission rate is a governance act no service performs on
    // its own authority (ADR-023) — and a signed tenant does not change that.
    const response = await request(http)
      .post('/v1/commissions/rules')
      .set('x-internal-token', await forTenant(payer))
      .send({ organizationId: payer, transactionType: 'LOGISTICS', rateBasisPoints: 100 })
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('never lets a relay token satisfy @AllowService, tenant claim or not', async () => {
    // A relay names a hop, not an actor. Reading one as a service call is what
    // broke every public endpoint behind the gateway (D-007), and signing a
    // tenant into it must not change that.
    for (const organizationId of [undefined, payer]) {
      const response = await request(http)
        .get('/v1/wallets/me')
        .set(
          'x-internal-token',
          await internalToken('api-gateway', { purpose: 'RELAY', organizationId }),
        )
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('still requires an Idempotency-Key from a service', async () => {
    // A retrying workflow is the caller most likely to send the same write
    // twice, so the requirement is stricter here rather than relaxed.
    const response = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await forTenant(payer))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '1000',
        holdFunds: false,
      })
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('does not grant a service the cross-tenant report a platform role gets', async () => {
    // `@AllowService` established that the calling service may use an
    // endpoint. Whether a report of every organization's balances should be
    // readable over an internal call is a different question, and the
    // conservative answer is the right one for a trial balance.
    await request(http)
      .get('/v1/ledger/trial-balance?currency=IRR')
      .set('x-internal-token', await forTenant(payer))
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // The path docs/08 § 8.6 specifies
  // -------------------------------------------------------------------------

  it('runs the order saga end to end, recording the service as the actor', async () => {
    const token = await forTenant(payer);
    const reference = id('s2s-order');

    // Activity one: record the obligation and reserve the money together.
    const created = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set('idempotency-key', reference)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '150000',
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: reference,
        holdFunds: true,
      })
      .expect(201);

    expect(created.body.status).toBe('HELD');
    expect(created.body.organizationId).toBe(payer);
    // No user, so the row names the service. An empty actor column on a
    // financial record leaves an auditor unable to say who committed the
    // organization at all (AGENTS.md S-06).
    expect(created.body.createdBy).toBe('economic-service');

    // Activity two: receipt confirmed, then pay.
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('x-internal-token', token)
      .set('idempotency-key', id('s2s-authorise'))
      .expect(200);

    const settled = await request(http)
      .post('/v1/settlements')
      .set('x-internal-token', token)
      .set('idempotency-key', id('s2s-settle'))
      .send({ transactionId: created.body.id })
      .expect(201);

    expect(BigInt(settled.body.grossAmountMinor)).toBe(150_000n);

    const settlement = await runUnscoped('the suite verifies the settlement it produced', () =>
      harness.prisma.client.settlement.findUnique({
        where: { id: settled.body.settlementId },
      }),
    );
    expect(settlement?.organizationId).toBe(payer);
    expect(settlement?.payeeOrganizationId).toBe(payee);
  });

  it('replays a saga activity without a second financial effect', async () => {
    // A workflow retries. The same signed token and the same key must produce
    // the first response, not a second hold.
    const token = await forTenant(payer);
    const key = id('s2s-replay');
    const body = {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '7000',
      currency: 'IRR',
      sourceType: 'ORDER',
      sourceReference: key,
      holdFunds: true,
    };

    const first = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set('idempotency-key', key)
      .send(body)
      .expect(201);

    const replay = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set('idempotency-key', key)
      .send(body)
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);

    const holds = await runUnscoped('the suite counts the holds the retry produced', () =>
      harness.prisma.client.walletHold.count({ where: { reference: first.body.id } }),
    );
    expect(holds).toBe(1);
  });
});
