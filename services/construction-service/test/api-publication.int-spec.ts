import request from 'supertest';
import { actor, apiTenant, auditorActor, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { approvedProject, cleanup, wire, type Wiring } from './helpers';

/**
 * The publication HTTP surface through the real `AppModule` (with a real
 * key-encryption key): closed without a token and to the oversight role, the
 * real status codes, strict bodies, and `404` across tenants.
 */

const DAY = 24 * 60 * 60 * 1000;
const CRITERIA = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];
const window = () => ({
  bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
  bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
});

describe('publication API', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const org = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };

  /** A tender through the API: created, complete or not, with criteria set. */
  async function tenderFor(a: string, extra: Record<string, unknown> = {}, criteria = CRITERIA) {
    const token = orgAdmin(a);
    const project = await approvedProject(w, a);
    const created = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(token))
      .send({
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres',
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        ...window(),
        ...extra,
      });
    expect(created.status).toBe(201);
    let version = created.body.version as number;
    if (criteria.length > 0) {
      const set = await http()
        .put(`/v1/tenders/${created.body.id as string}/criteria`)
        .set(as(token))
        .send({ expectedVersion: version, criteria });
      expect(set.status).toBe(200);
      version = set.body.version as number;
    }
    return { id: created.body.id as string, version, token };
  }

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  it('is closed without a token, to the oversight role, and to a role the configuration did not grant', async () => {
    const a = org('closed');
    const routes: [string, string, object][] = [
      ['post', '/v1/tenders/TND_x/publish', { expectedVersion: 1 }],
      ['post', '/v1/tenders/TND_x/invitations', { organizationId: 'ORG_X' }],
      ['get', '/v1/tenders/TND_x/invitations', {}],
    ];
    for (const [method, path, body] of routes) {
      const call = (token?: string) => {
        const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(
          path,
        );
        return (token ? req.set(as(token)) : req).send(body);
      };
      expect((await call()).status).toBe(401);
      expect((await call(auditorActor(a))).status).toBe(403);
      expect((await call(actor(a, ['DRIVER']))).status).toBe(403);
    }
  });

  it('publishes a complete tender (200), and says what a second attempt is (422)', async () => {
    const a = org('publish');
    const { id, version, token } = await tenderFor(a);

    const published = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      status: 'PUBLISHED',
      version: version + 1,
      publishedBy: expect.any(String),
    });
    // Nothing of the key is ever in a response.
    expect(JSON.stringify(published.body)).not.toMatch(/KEY|wrapped|kek/i);

    const again = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version + 1 });
    expect(again.status).toBe(422);
    const stale = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
  });

  it('refuses an incomplete tender with 422 and names every reason', async () => {
    const a = org('incomplete');
    const { id, version, token } = await tenderFor(a, { visibility: 'RESTRICTED' }, [CRITERIA[0]!]);

    const refused = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });

    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(refused.body.message).toContain('CRITERIA_WEIGHTS_INCOMPLETE');
    expect(refused.body.message).toContain('INVITATION_REQUIRED');
    expect((await http().get(`/v1/tenders/${id}`).set(as(token))).body.status).toBe('DRAFT');
  });

  it('invites (201), lists, and refuses a repeat (409), the owner itself (422) and a public tender (422)', async () => {
    const a = org('invite');
    const { id, version, token } = await tenderFor(a, { visibility: 'RESTRICTED' });

    const invited = await http()
      .post(`/v1/tenders/${id}/invitations`)
      .set(as(token))
      .send({ organizationId: 'ORG_BIDDER_1' });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ tenderId: id, invitedOrganizationId: 'ORG_BIDDER_1' });
    expect(
      (
        await http()
          .post(`/v1/tenders/${id}/invitations`)
          .set(as(token))
          .send({ organizationId: 'ORG_BIDDER_1' })
      ).status,
    ).toBe(409);
    expect(
      (
        await http()
          .post(`/v1/tenders/${id}/invitations`)
          .set(as(token))
          .send({ organizationId: a })
      ).status,
    ).toBe(422);
    const list = await http().get(`/v1/tenders/${id}/invitations`).set(as(token));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);

    const published = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });
    expect(published.status).toBe(200);

    const open = await tenderFor(org('invite-public'));
    expect(
      (
        await http()
          .post(`/v1/tenders/${open.id}/invitations`)
          .set(as(open.token))
          .send({ organizationId: 'ORG_X' })
      ).status,
    ).toBe(422);
  });

  it('refuses bodies that decide what they may not', async () => {
    const a = org('strict');
    const { id, version, token } = await tenderFor(a);
    for (const body of [
      {},
      { expectedVersion: version, status: 'PUBLISHED' },
      { expectedVersion: version, publishedBy: 'USR_x' },
      { expectedVersion: version, organizationId: 'ORG_x' },
    ]) {
      expect(
        (await http().post(`/v1/tenders/${id}/publish`).set(as(token)).send(body)).status,
      ).toBe(400);
    }
    for (const body of [
      {},
      { organizationId: '' },
      { organizationId: 'ORG_X', invitedBy: 'USR_x' },
    ]) {
      expect(
        (await http().post(`/v1/tenders/${id}/invitations`).set(as(token)).send(body)).status,
      ).toBe(400);
    }
  });

  it('answers 404 to another organization on every route', async () => {
    const a = org('owner');
    const b = org('stranger');
    const { id, version } = await tenderFor(a, { visibility: 'RESTRICTED' });
    const stranger = as(orgAdmin(b));

    expect(
      (
        await http()
          .post(`/v1/tenders/${id}/publish`)
          .set(stranger)
          .send({ expectedVersion: version })
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .post(`/v1/tenders/${id}/invitations`)
          .set(stranger)
          .send({ organizationId: 'ORG_X' })
      ).status,
    ).toBe(404);
    expect((await http().get(`/v1/tenders/${id}/invitations`).set(stranger)).status).toBe(404);
  });
});
