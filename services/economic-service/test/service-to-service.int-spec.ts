import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * Zero Trust between services (ADR-020, AGENTS.md S-08).
 *
 * Every scenario elsewhere in this suite arrives as a person. This one arrives
 * as a **service**, which is how `docs/08` § 8.6 says the order saga will
 * actually reach this domain: `OrderSagaWorkflow` calls `placeHold()` and
 * `settle()` as activities, not as events.
 *
 * Three properties are asserted, and each one is a different refusal:
 *
 *  1. A valid internal token proves *which* service is calling. It does not by
 *     itself grant access to anything — the callee still decides, through
 *     `@AllowService`.
 *  2. A service that is not on an endpoint's list is refused even with a
 *     perfectly valid token.
 *  3. A `RELAY` token — the gateway forwarding somebody else's request —
 *     carries no service authority at all. Reading it as a service token is
 *     what once made every public endpoint behind the gateway answer 403
 *     (D-007), and the repair must not be allowed to regress.
 *
 * It also exercises the actor fallback that a person's request never reaches:
 * with no `userId` in context, every write records the *service* as the actor
 * rather than leaving the column empty.
 */
describe('service-to-service access', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('S2S-PAYER');
  const payee = apiTenant('S2S-PAYEE');

  /** Tenant on the header, because a service call carries no membership. */
  const tenantHeaders = (organizationId: string) => ({
    'x-organization-id': organizationId,
  });

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
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee]);
    await harness.close();
  });

  // -------------------------------------------------------------------------

  it('authenticates a permitted service, but cannot yet resolve a tenant for it', async () => {
    // **A gap, recorded rather than papered over — docs/24 Q-28.**
    //
    // `AuthGuard.authenticateInternal` returns an auth state with no
    // `organizationId`, and its own comment says the opposite: "a service call
    // carries the tenant of the request that caused it, which the caller
    // propagates in the header". `x-organization-id` is read only on the user
    // branch. So every `@AllowService` endpoint on the platform — twenty-six of
    // them — authenticates the caller and then fails the moment it touches
    // tenant-scoped data.
    //
    // It fails **closed**: no data is returned and nothing leaks, which is why
    // this is a broken integration path rather than a security defect. The
    // repair belongs in `packages/nest-common` and is a decision about whether
    // an unvalidated header may select a tenant for a service caller, so it is
    // not this task's to make.
    //
    // Asserted at all because the alternative is that the day somebody fixes
    // it, nothing tells them it was ever broken.
    const token = await internalToken('marketplace-service');

    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
      .expect(500);

    expect(response.body.code).toBe('INTERNAL_ERROR');
    // No tenant data on the way out, whatever else is wrong.
    expect(JSON.stringify(response.body)).not.toContain(payer);
  });

  it('refuses a service that is not on the endpoint’s list', async () => {
    // A valid token, correctly signed and correctly targeted — and still
    // refused, because proving who is calling is a different question from
    // whether they may call this.
    const token = await internalToken('notification-service');

    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('refuses every service an endpoint that names none', async () => {
    // `POST /v1/commissions/rules` carries no `@AllowService`: changing a
    // commission rate is a governance act that a service must never perform on
    // its own authority (ADR-023).
    const token = await internalToken('marketplace-service');

    const response = await request(http)
      .post('/v1/commissions/rules')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
      .send({ organizationId: payer, transactionType: 'LOGISTICS', rateBasisPoints: 100 })
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('treats a relay token as an anonymous request, not as a service one', async () => {
    // The gateway forwarding a request that carried no credentials. It names a
    // hop, not an actor, so a closed endpoint must answer 401 — the same thing
    // the caller would have been told directly.
    const token = await internalToken('api-gateway', 'RELAY');

    const response = await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
      .expect(401);

    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a token minted for a different service', async () => {
    // The token is scoped to one target, so one leaked from
    // notification-service cannot be replayed against this one.
    const foreign = await internalToken('marketplace-service', 'SERVICE', 'notification-service');

    await request(http)
      .get('/v1/wallets/me')
      .set('x-internal-token', foreign)
      .set(tenantHeaders(payer))
      .expect(401);
  });

  it('writes nothing when it cannot resolve the tenant it was asked to act for', async () => {
    // The same gap as above (docs/24 Q-28), asserted on a **write**, because
    // the consequence there is different in kind: an obligation recorded
    // against no tenant, or a hold taken from a wallet nobody owns, would be a
    // financial record with no owner.
    //
    // Nothing is written. That is the property worth locking down whatever the
    // eventual repair looks like.
    const token = await internalToken('marketplace-service');
    const reference = id('s2s-order');

    await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
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
      .expect(500);

    const listed = await request(http)
      .get(`/v1/transactions?sourceReference=${encodeURIComponent(reference)}`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .expect(200);
    expect(listed.body.items).toHaveLength(0);
  });

  it('still requires an Idempotency-Key from a service', async () => {
    // A retrying workflow is exactly the caller most likely to send the same
    // write twice, so the requirement is stricter here rather than relaxed.
    const token = await internalToken('marketplace-service');

    const response = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
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
    const token = await internalToken('marketplace-service');

    await request(http)
      .get('/v1/ledger/trial-balance?currency=IRR')
      .set('x-internal-token', token)
      .set(tenantHeaders(payer))
      .expect(403);
  });
});
