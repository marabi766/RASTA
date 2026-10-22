import request from 'supertest';
import { actor, buyer, client, internalToken, key } from './api-helpers';
import { startRfqApi, type RfqHarness } from './rfq-helpers';

/**
 * Who reads an RFQ (ADR-070 § 4, § 10; plan PR 6): its buyer, by the read roles; an invited
 * supplier, by PROCUREMENT_SUPPLIER_ROLES, across the tenant guard with its own invitation as the
 * predicate — the product, the total, the criteria and the deadline, never the other invitees, the
 * cancellation's text or who registered the demands. Anyone else gets the 404 a missing id gets;
 * AUDITOR, SYSTEM_ADMIN and a service token are refused before anything is read.
 */
describe('reading RFQs, as the buyer and as an invited supplier', () => {
  let h: RfqHarness;
  let buyerOrg: string;
  let rfq: Record<string, unknown> & { id: string };
  let invitees: string[];

  beforeAll(async () => {
    h = await startRfqApi();
    const ready = await h.readyAggregation();
    buyerOrg = ready.organizationId;
    const body = h.issueBody(ready.aggregation);
    invitees = body.invitedSupplierOrganizationIds;
    rfq = (await h.admin(buyerOrg).issueRfq(ready.aggregation.id, body)).body;
    expect(rfq.status).toBe('PUBLISHED');
  });

  afterAll(async () => {
    await h.close();
  });

  const supplierOf = (organizationId: string, roles = ['SUPPLIER']) =>
    client(h.api, actor(organizationId, roles));

  it('the buyer reads it whole, by PROCUREMENT_USER (rfq:read) or the issuer role, and lists it', async () => {
    for (const roles of [['PROCUREMENT_USER'], ['ORGANIZATION_ADMIN']]) {
      const as = client(h.api, actor(buyerOrg, roles));
      const read = await as.rfq(rfq.id);
      expect(read.status).toBe(200);
      expect(read.body).toEqual(rfq);
      const listed = await as.rfqs('?side=BUYER');
      expect(listed.status).toBe(200);
      expect(listed.body.items).toEqual([rfq]);
    }
  });

  it('an invited supplier reads what it is asked to quote for — not the other invitees, nor the buyer’s reason — and lists only the RFQs that invite it', async () => {
    const supplier = supplierOf(invitees[0]!);
    const read = await supplier.rfq(rfq.id);

    expect(read.status).toBe(200);
    const { invitedSupplierOrganizationIds: _invited, cancelReason: _reason, ...shared } = rfq;
    expect(read.body).toEqual(shared);
    expect(JSON.stringify(read.body)).not.toContain(invitees[1]!);

    const listed = await supplier.rfqs('?side=SUPPLIER');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ items: [shared], nextCursor: null });
    expect((await supplier.rfqs('?side=SUPPLIER&status=CLOSED')).body.items).toEqual([]);
  });

  it('an organization the RFQ does not invite, and a third organization, get the 404 a missing id gets; their lists are empty', async () => {
    const outsider = h.supplier.organization();
    for (const as of [
      supplierOf(outsider),
      client(h.api, actor(h.org(), ['ORGANIZATION_ADMIN', 'SUPPLIER'])),
    ]) {
      const read = await as.rfq(rfq.id);
      const missing = await as.rfq('RFQ_01JAAAAAAAAAAAAAAAAAAAAAAA');
      expect([read.status, missing.status]).toEqual([404, 404]);
      expect(Object.keys(read.body).sort()).toEqual(Object.keys(missing.body).sort());
      expect((await as.rfqs('?side=SUPPLIER')).body.items).toEqual([]);
    }
    expect((await client(h.api, buyer(h.org())).rfqs('?side=BUYER')).body.items).toEqual([]);
  });

  it('an invited organization reading without a supplier role finds nothing: 404; its list on the supplier side is 403', async () => {
    const asAdmin = supplierOf(invitees[0]!, ['ORGANIZATION_ADMIN']);
    expect((await asAdmin.rfq(rfq.id)).status).toBe(404);
    expect((await asAdmin.rfqs('?side=SUPPLIER')).status).toBe(403);
  });

  it('a person of the buyer without a read role is 403 on its RFQ — a SUPPLIER of the buyer too — and on its list', async () => {
    for (const roles of [['FLEET_MANAGER'], ['SUPPLIER']]) {
      const as = client(h.api, actor(buyerOrg, roles));
      expect((await as.rfq(rfq.id)).status).toBe(403);
      expect((await as.rfqs('?side=BUYER')).status).toBe(403);
    }
  });

  it.each([
    ['AUDITOR', () => actor(buyerOrg, ['AUDITOR', 'ORGANIZATION_ADMIN'])],
    [
      'the platform administrator, acting for the buyer',
      () => actor(buyerOrg, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']),
    ],
    [
      'the platform administrator, beside a supplier role of an invitee',
      () => actor(invitees[0]!, ['SYSTEM_ADMIN', 'SUPPLIER']),
    ],
  ])('%s: 403 on every RFQ route, before anything is read', async (_label, token) => {
    const as = client(h.api, token());
    for (const response of [
      await as.rfq(rfq.id),
      await as.rfqs('?side=BUYER'),
      await as.rfqs('?side=SUPPLIER'),
      await as.closeRfq(rfq.id),
      await as.cancelRfq(rfq.id, 1),
    ]) {
      expect(response.status).toBe(403);
    }
  });

  it('a service token, even one signed for the buyer: 403 on every RFQ route', async () => {
    const token = await internalToken('economic-service', buyerOrg);
    const http = () => request(h.api.app.getHttpServer());
    for (const response of [
      await http().get(`/v1/rfqs/${rfq.id}`).set('x-internal-token', token),
      await http().get('/v1/rfqs?side=BUYER').set('x-internal-token', token),
      await http()
        .post(`/v1/rfqs/${rfq.id}/close`)
        .set('x-internal-token', token)
        .set('idempotency-key', key())
        .send({}),
    ]) {
      expect(response.status).toBe(403);
    }
  });

  it('the side is required and closed; a list pages by cursor', async () => {
    const as = client(h.api, buyer(buyerOrg));
    expect((await as.rfqs('')).status).toBe(400);
    expect((await as.rfqs('?side=ANY')).status).toBe(400);

    const ready = await h.readyAggregation(buyerOrg);
    const second = (
      await h.admin(buyerOrg).issueRfq(ready.aggregation.id, h.issueBody(ready.aggregation))
    ).body;
    const page = (await as.rfqs('?side=BUYER&limit=1')).body;
    expect(page.items.map((item: { id: string }) => item.id)).toEqual([second.id]);
    expect(page.nextCursor).toBe(second.id);
    const next = (await as.rfqs(`?side=BUYER&limit=1&cursor=${page.nextCursor as string}`)).body;
    expect(next).toEqual({ items: [rfq], nextCursor: null });
  });
});
