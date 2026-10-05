import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  actor,
  auditor,
  contractor,
  internalToken,
  orgAdmin,
  startApi,
  systemAdminOf,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  newAward,
  newOrganizationId,
  tenderAwarded,
  wire,
  type AwardFixture,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 1 (ADR-068 § 7): the contract read API, from the real `AppModule` over real
 * guards and a real database — closed by default, and `404` (never `403`) for any
 * organization that is not a party to the contract.
 */
describe('contract read API', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const employer = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A contract made the way the system makes one: the consumer, from a confirmed award. */
  async function draft(
    organizationId: string,
    overrides: Partial<AwardFixture> = {},
  ): Promise<{ id: string; award: AwardFixture }> {
    const award = newAward(organizationId, overrides);
    w.awards.serve(award);
    await w.consumer.handle(tenderAwarded(award));
    const row = await runUnscoped('the suite reads back the contract it just seeded', () =>
      w.contracts.findByTender(organizationId, award.tenderId),
    );
    return { id: row!.id, award };
  }

  const get = (path: string, token?: string, headers: Record<string, string> = {}) => {
    const r = request(api.app.getHttpServer()).get(path);
    if (token) r.set('authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('closed by default', () => {
    it('refuses a request with no token: 401 on the list and on a read', async () => {
      await get('/v1/contracts').expect(401);
      await get('/v1/contracts/CTR_anything').expect(401);
    });

    it('refuses a malformed token', async () => {
      await get('/v1/contracts', 'not-a-token').expect(401);
    });

    it('refuses an AUDITOR even in the employer’s own organization: aggregate access only', async () => {
      const o = employer();
      const { id } = await draft(o);
      await get('/v1/contracts', auditor(o)).expect(403);
      await get(`/v1/contracts/${id}`, auditor(o)).expect(403);
    });

    it('refuses a service token: no service-to-service access to contracts is granted', async () => {
      const o = employer();
      const { id } = await draft(o);
      for (const caller of ['economic-service', 'construction-service']) {
        const token = await internalToken(caller, { organizationId: o });
        await request(api.app.getHttpServer())
          .get(`/v1/contracts/${id}`)
          .set('x-internal-token', token)
          .expect(403);
      }
    });

    it('refuses a role that is neither a reader nor the contractor: 403', async () => {
      const o = employer();
      await get('/v1/contracts', actor(o, ['DRIVER'])).expect(403);
      await get('/v1/contracts', actor(o, ['FLEET_MANAGER'])).expect(403);
    });

    it('has no route that writes a contract: no user creates, edits or removes one', async () => {
      const o = employer();
      const { id } = await draft(o);
      const http = request(api.app.getHttpServer());
      const token = `Bearer ${orgAdmin(o)}`;
      await http.post('/v1/contracts').set('authorization', token).send({}).expect(404);
      await http.put(`/v1/contracts/${id}`).set('authorization', token).send({}).expect(404);
      await http.patch(`/v1/contracts/${id}`).set('authorization', token).send({}).expect(404);
      await http.delete(`/v1/contracts/${id}`).set('authorization', token).expect(404);
    });
  });

  describe('the employer’s organization', () => {
    it('reads its own contract, the amount a decimal string in minor units', async () => {
      const o = employer();
      const { id, award } = await draft(o, { amountMinor: '9007199254740993' });

      const response = await get(`/v1/contracts/${id}`, orgAdmin(o)).expect(200);

      expect(response.body).toMatchObject({
        id,
        organizationId: o,
        tenderId: award.tenderId,
        projectId: award.projectId,
        winningBidId: award.winningBidId,
        contractorOrganizationId: award.winnerOrganizationId,
        // Beyond Number.MAX_SAFE_INTEGER: a float would have rounded it.
        amountMinor: '9007199254740993',
        status: 'DRAFT',
        version: 1,
      });
    });

    it('lists its own contracts, newest first, and nobody else’s', async () => {
      const a = employer();
      const b = employer();
      const first = await draft(a);
      const second = await draft(a);
      const others = await draft(b);

      const response = await get('/v1/contracts', orgAdmin(a)).expect(200);

      const ids = (response.body.items as { id: string }[]).map((c) => c.id);
      expect(ids).toEqual([second.id, first.id]);
      expect(ids).not.toContain(others.id);
      expect(response.body).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('pages with a cursor and filters by status', async () => {
      const o = employer();
      const made = [await draft(o), await draft(o), await draft(o)];

      const page1 = await get('/v1/contracts?limit=2', orgAdmin(o)).expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);

      const page2 = await get(
        `/v1/contracts?limit=2&cursor=${page1.body.nextCursor as string}`,
        orgAdmin(o),
      ).expect(200);
      const all = [...page1.body.items, ...page2.body.items].map((c: { id: string }) => c.id);
      expect(all).toEqual(made.map((m) => m.id).reverse());
      expect(page2.body.hasMore).toBe(false);

      expect(
        (await get('/v1/contracts?status=DRAFT', orgAdmin(o)).expect(200)).body.items,
      ).toHaveLength(3);
      expect(
        (await get('/v1/contracts?status=SIGNED', orgAdmin(o)).expect(200)).body.items,
      ).toHaveLength(0);
    });

    it('refuses an unknown status and a stray query field: 400', async () => {
      const o = employer();
      await get('/v1/contracts?status=PAID', orgAdmin(o)).expect(400);
      await get('/v1/contracts?organizationId=ORG_x', orgAdmin(o)).expect(400);
    });

    it('lets a SYSTEM_ADMIN read for the organization it selects, and only that one', async () => {
      const a = employer();
      const b = employer();
      const mine = await draft(a);
      const theirs = await draft(b);
      const token = systemAdminOf(a);

      const list = await get('/v1/contracts', token, { 'x-organization-id': a }).expect(200);
      expect((list.body.items as { id: string }[]).map((c) => c.id)).toEqual([mine.id]);
      await get(`/v1/contracts/${theirs.id}`, token, { 'x-organization-id': a }).expect(404);
    });

    it('refuses a SYSTEM_ADMIN who selected no organization: a contract has exactly one employer', async () => {
      await get('/v1/contracts', systemAdminWithoutTenant()).expect(403);
    });
  });

  describe('the winning contractor', () => {
    it('reads the contract it won, and lists it, from its own organization', async () => {
      const o = employer();
      const { id, award } = await draft(o);
      const winner = award.winnerOrganizationId;

      const one = await get(`/v1/contracts/${id}`, contractor(winner)).expect(200);
      expect(one.body.id).toBe(id);

      const list = await get('/v1/contracts', contractor(winner)).expect(200);
      expect((list.body.items as { id: string }[]).map((c) => c.id)).toEqual([id]);
    });

    it('lists only what it won, across employers', async () => {
      const a = employer();
      const b = employer();
      const winner = newOrganizationId();
      const one = await draft(a, { winnerOrganizationId: winner });
      const two = await draft(b, { winnerOrganizationId: winner });
      await draft(a); // another contractor's

      const list = await get('/v1/contracts', contractor(winner)).expect(200);

      expect((list.body.items as { id: string }[]).map((c) => c.id).sort()).toEqual(
        [one.id, two.id].sort(),
      );
    });

    it('an organization that is both employer and winner reads both sides, newest first, and pages across them', async () => {
      const x = employer();
      const y = employer();
      const asEmployer = await draft(x);
      const asContractor = await draft(y, { winnerOrganizationId: x });
      const both = actor(x, ['ORGANIZATION_ADMIN', 'CONTRACTOR']);

      const list = await get('/v1/contracts', both).expect(200);
      expect((list.body.items as { id: string }[]).map((c) => c.id)).toEqual([
        asContractor.id,
        asEmployer.id,
      ]);

      const first = await get('/v1/contracts?limit=1', both).expect(200);
      expect(first.body).toMatchObject({ hasMore: true, nextCursor: asContractor.id });
      const second = await get(`/v1/contracts?limit=1&cursor=${asContractor.id}`, both).expect(200);
      expect((second.body.items as { id: string }[]).map((c) => c.id)).toEqual([asEmployer.id]);
      expect(second.body.hasMore).toBe(false);

      await get(`/v1/contracts/${asEmployer.id}`, both).expect(200);
      await get(`/v1/contracts/${asContractor.id}`, both).expect(200);
    });

    it('does not read as the contractor with another role: only the CONTRACTOR role of its own organization', async () => {
      const o = employer();
      const { id, award } = await draft(o);
      await get(`/v1/contracts/${id}`, orgAdmin(award.winnerOrganizationId)).expect(404);
      await get(`/v1/contracts/${id}`, actor(award.winnerOrganizationId, ['DRIVER'])).expect(403);
    });

    it('does not read as the contractor while acting as the platform administrator', async () => {
      const o = employer();
      const { id, award } = await draft(o);
      const token = actor(award.winnerOrganizationId, ['SYSTEM_ADMIN', 'CONTRACTOR']);
      await get(`/v1/contracts/${id}`, token, {
        'x-organization-id': award.winnerOrganizationId,
      }).expect(404);
    });
  });

  describe('tenant isolation', () => {
    it('answers an organization that is no party with 404 — the same body as a contract that does not exist', async () => {
      const a = employer();
      const b = employer();
      const { id } = await draft(a);

      const notMine = await get(`/v1/contracts/${id}`, orgAdmin(b)).expect(404);
      const missing = await get('/v1/contracts/CTR_doesnotexist', orgAdmin(b)).expect(404);

      expect(notMine.body.code).toBe('NOT_FOUND');
      expect(Object.keys(notMine.body).sort()).toEqual(Object.keys(missing.body).sort());
      // 404, not 403, and one body: nothing tells "exists, not yours" from "missing" — the
      // message does not even echo the identifier asked for.
      expect(notMine.status).toBe(missing.status);
      expect(notMine.body.message).toBe('Contract not found');
      expect(notMine.body.message).toBe(missing.body.message);
      expect(notMine.body.code).toBe(missing.body.code);
    });

    it('does not list another organization’s contracts, whatever it asks for', async () => {
      const a = employer();
      const b = employer();
      await draft(a);

      const list = await get('/v1/contracts', orgAdmin(b)).expect(200);
      expect(list.body.items).toEqual([]);
      const filtered = await get('/v1/contracts?status=DRAFT&limit=100', orgAdmin(b)).expect(200);
      expect(filtered.body.items).toEqual([]);
    });

    it('does not let a cursor reach another organization’s rows', async () => {
      const a = employer();
      const b = employer();
      const theirs = await draft(a);
      await draft(a);

      // A cursor naming A's newest id, used by B: still only B's (nothing).
      const list = await get(`/v1/contracts?cursor=${theirs.id}x`, orgAdmin(b)).expect(200);
      expect(list.body.items).toEqual([]);
    });

    it('refuses X-Organization-Id naming an organization the caller does not belong to', async () => {
      const a = employer();
      const b = employer();
      await draft(b);
      const response = await get('/v1/contracts', orgAdmin(a), { 'x-organization-id': b });
      expect([401, 403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain(b);
    });

    it('does not show the employer’s side to its own contractor role in the employer’s organization', async () => {
      const o = employer();
      const { id } = await draft(o);
      // CONTRACTOR in the employer's organization is no party: the contract names another winner.
      await get(`/v1/contracts/${id}`, contractor(o)).expect(404);
    });
  });
});
