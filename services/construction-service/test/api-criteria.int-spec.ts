import request from 'supertest';
import { actor, apiTenant, auditorActor, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { approvedProject, asAdmin, cancelApproved, cleanup, wire, type Wiring } from './helpers';

/**
 * The criteria HTTP surface through the real `AppModule`: closed without a
 * token and to the oversight role, strict bodies, the real status codes, and
 * `404` across tenants.
 */

const WHOLE = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];
const TENDER = { title: 'Road resurfacing', scopeOfWork: 'Two kilometres' };

describe('criteria API', () => {
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
      ['post', '/v1/criteria-templates', { label: 'Roads', criteria: WHOLE }],
      ['get', '/v1/criteria-templates', {}],
      ['get', '/v1/criteria-templates/CTP_x', {}],
      ['put', '/v1/tenders/TND_x/criteria', { expectedVersion: 1, criteria: WHOLE }],
      ['get', '/v1/tenders/TND_x/criteria', {}],
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

  it('writes a template (201), versions it, reads and lists it, and sets a tender’s criteria from it', async () => {
    const a = org('flow');
    const token = orgAdmin(a);
    const project = await approvedProject(w, a);
    const tender = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(token))
      .send(TENDER);
    const tenderId = tender.body.id as string;

    const v1 = await http()
      .post('/v1/criteria-templates')
      .set(as(token))
      .send({ label: 'Roads', criteria: WHOLE });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, totalWeightBp: 10_000, organizationId: a });
    const v2 = await http()
      .post('/v1/criteria-templates')
      .set(as(token))
      .send({ label: 'Roads', criteria: [WHOLE[0]] });
    expect(v2.body.version).toBe(2);

    expect(
      (
        await http()
          .get(`/v1/criteria-templates/${v1.body.id as string}`)
          .set(as(token))
      ).status,
    ).toBe(200);
    const list = await http().get('/v1/criteria-templates?label=Roads').set(as(token));
    expect(list.body.items.map((item: { version: number }) => item.version)).toEqual([2, 1]);

    const set = await http()
      .put(`/v1/tenders/${tenderId}/criteria`)
      .set(as(token))
      .send({ expectedVersion: 1, templateId: v1.body.id });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ complete: true, totalWeightBp: 10_000, version: 2 });
    expect(set.body.items).toHaveLength(2);
    expect((await http().get(`/v1/tenders/${tenderId}/criteria`).set(as(token))).body).toEqual(
      set.body,
    );

    const stale = await http()
      .put(`/v1/tenders/${tenderId}/criteria`)
      .set(as(token))
      .send({ expectedVersion: 1, criteria: WHOLE });
    expect(stale.status).toBe(409);

    // Cancelling is behind the approval gate (Q-84): through it, as the owner's administrator.
    await asAdmin(a, () =>
      cancelApproved(w, tenderId, { expectedVersion: 2, reason: 'Funding was withdrawn' }),
    );
    const late = await http()
      .put(`/v1/tenders/${tenderId}/criteria`)
      .set(as(token))
      .send({ expectedVersion: 3, criteria: WHOLE });
    expect(late.status).toBe(422);
  });

  it('refuses bodies that decide what they may not, and weights that cannot be right', async () => {
    const a = org('strict');
    const token = orgAdmin(a);
    const bad: object[] = [
      { label: 'Roads', criteria: [{ ...WHOLE[0], position: 3 }] },
      { label: 'Roads', criteria: [{ ...WHOLE[0], organizationId: 'ORG_x' }] },
      { label: 'Roads', criteria: [{ ...WHOLE[0], weightBp: 10.5 }] },
      { label: 'Roads', criteria: [{ ...WHOLE[0], scoringMethod: 'LOWEST_PRICE_RATIO' }] },
      { label: 'Roads', criteria: [WHOLE[0], { ...WHOLE[1], weightBp: 4001 }] },
      { label: 'Roads', criteria: [WHOLE[0], WHOLE[0]] },
      { label: 'Roads', criteria: WHOLE, version: 9 },
      { label: 'Roads', criteria: [] },
    ];
    for (const body of bad) {
      expect((await http().post('/v1/criteria-templates').set(as(token)).send(body)).status).toBe(
        400,
      );
    }
    const both = await http()
      .put('/v1/tenders/TND_x/criteria')
      .set(as(token))
      .send({ expectedVersion: 1, templateId: 'CTP_x', criteria: WHOLE });
    expect(both.status).toBe(400);
  });

  it('answers 404 to another organization on every route', async () => {
    const a = org('owner');
    const b = org('stranger');
    const project = await approvedProject(w, a);
    const tender = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(orgAdmin(a)))
      .send(TENDER);
    const template = await http()
      .post('/v1/criteria-templates')
      .set(as(orgAdmin(a)))
      .send({ label: 'Roads', criteria: WHOLE });
    const stranger = as(orgAdmin(b));

    expect(
      (
        await http()
          .get(`/v1/criteria-templates/${template.body.id as string}`)
          .set(stranger)
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .get(`/v1/tenders/${tender.body.id as string}/criteria`)
          .set(stranger)
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .put(`/v1/tenders/${tender.body.id as string}/criteria`)
          .set(stranger)
          .send({ expectedVersion: 1, criteria: WHOLE })
      ).status,
    ).toBe(404);
    expect((await http().get('/v1/criteria-templates').set(stranger)).body.items).toEqual([]);
  });

  it('replays an idempotent template write and refuses the key with another body', async () => {
    const a = org('idem');
    const headers = { ...as(orgAdmin(a)), 'idempotency-key': 'api-template-key-1' };
    const body = { label: 'Roads', criteria: WHOLE };
    const first = await http().post('/v1/criteria-templates').set(headers).send(body);
    const again = await http().post('/v1/criteria-templates').set(headers).send(body);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.id).toBe(first.body.id);
    const other = await http()
      .post('/v1/criteria-templates')
      .set(headers)
      .send({ ...body, label: 'Other' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
