import request from 'supertest';
import {
  reasonsOf,
  actor,
  apiTenant,
  auditorActor,
  orgAdmin,
  startApi,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import { PROJECT, approvedProject, cleanup, ensureGatePolicy, wire, type Wiring } from './helpers';

/**
 * The tender HTTP surface, through the real `AppModule` (real guards, real
 * router, real database): closed without a token, closed to the oversight
 * role, strict bodies, the real status codes, and `404` across tenants.
 */

const TENDER = { title: 'Road resurfacing', scopeOfWork: 'Two kilometres of the main road' };

describe('tender API', () => {
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
    // Valid bodies: the role is checked by the service, after the body pipe, so
    // an empty body would be a 400 and prove nothing about who may call.
    const routes: [string, string, object][] = [
      ['post', '/v1/projects/PRJ_x/tenders', TENDER],
      ['get', '/v1/tenders', {}],
      ['get', '/v1/tenders/TND_x', {}],
      ['patch', '/v1/tenders/TND_x', { expectedVersion: 1, title: 'Renamed tender' }],
      ['post', '/v1/tenders/TND_x/cancel', { expectedVersion: 1, reason: 'Funding was withdrawn' }],
      ['get', '/v1/tenders/TND_x/approvals', {}],
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

  it('asks a system administrator with no organization to select one', async () => {
    const response = await http().get('/v1/tenders').set(as(systemAdminWithoutTenant()));
    expect(response.status).toBe(403);
  });

  it('creates (201), reads, lists, edits and cancels a tender with the real status codes', async () => {
    const a = org('lifecycle');
    const project = await approvedProject(w, a);
    const token = orgAdmin(a);

    const created = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(token))
      .send({
        ...TENDER,
        procurementNature: 'RFP',
        bidOpeningAt: '2026-11-01T08:00:00Z',
        bidClosingAt: '2026-11-30T20:30:00Z',
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      organizationId: a,
      projectId: project.id,
      status: 'DRAFT',
      version: 1,
      procurementNature: 'RFP',
      bidClosingAt: '2026-11-30T20:30:00.000Z',
    });
    const id = created.body.id as string;

    expect((await http().get(`/v1/tenders/${id}`).set(as(token))).status).toBe(200);
    const list = await http().get('/v1/tenders').set(as(token));
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(list.body.items[0]).not.toHaveProperty('scopeOfWork');

    const edited = await http()
      .patch(`/v1/tenders/${id}`)
      .set(as(token))
      .send({ expectedVersion: 1, visibility: 'PUBLIC' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ version: 2, visibility: 'PUBLIC' });

    const stale = await http()
      .patch(`/v1/tenders/${id}`)
      .set(as(token))
      .send({ expectedVersion: 1, visibility: 'RESTRICTED' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');

    // Every cancellation is behind the gate: no policy, no cancellation (422); with one, 202, an approval by
    // someone else, and the same command cancels.
    const cancel = (as_: string) =>
      http()
        .post(`/v1/tenders/${id}/cancel`)
        .set(as(as_))
        .send({ expectedVersion: 2, reason: 'Funding was withdrawn' });
    const ungated = await cancel(token);
    expect(ungated.status).toBe(422);
    expect(ungated.body.message).toContain('APPROVAL_POLICY_REQUIRED');
    expect(reasonsOf(ungated.body)).toEqual(['approval:APPROVAL_POLICY_REQUIRED']);
    expect(ungated.body.details).toEqual([
      {
        path: 'approval',
        code: 'APPROVAL_POLICY_REQUIRED',
        message: 'Approval refused: APPROVAL_POLICY_REQUIRED',
      },
    ]);
    await ensureGatePolicy(w, a, 'tender.cancellation');
    const asked = await cancel(token);
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ workflowKey: 'tender.cancellation', status: 'PENDING' });
    const stepId = asked.body.steps[0].approvalId as string;
    const step = await http().get(`/v1/approvals/${stepId}`).set(as(token));
    expect(step.body.request.cancellation).toEqual({
      reason: 'Funding was withdrawn',
      reasonCode: 'OWNER_REQUEST',
    });
    const granted = await http()
      .post(`/v1/approvals/${stepId}/decision`)
      .set(as(orgAdmin(a)))
      .send({ decision: 'GRANT', expectedVersion: step.body.version });
    expect(granted.status).toBe(200);
    const cancelled = await cancel(token);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      statusReasonCode: 'OWNER_REQUEST',
    });

    const late = await http()
      .patch(`/v1/tenders/${id}`)
      .set(as(token))
      .send({ expectedVersion: 3, title: 'Too late' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refuses a body that names the owner, the status or an actor: those are decided elsewhere', async () => {
    const a = org('strict');
    const project = await approvedProject(w, a);
    const token = orgAdmin(a);

    for (const extra of [
      { organizationId: 'ORG_other' },
      { status: 'PUBLISHED' },
      { createdBy: 'USR_other' },
      { version: 9 },
    ]) {
      const response = await http()
        .post(`/v1/projects/${project.id}/tenders`)
        .set(as(token))
        .send({ ...TENDER, ...extra });
      expect(response.status).toBe(400);
    }
    for (const bad of [
      { bidOpeningAt: '2026-11-01T08:00:00+03:30', bidClosingAt: '2026-11-30T20:30:00Z' },
      { bidOpeningAt: '2026-11-30T20:30:00Z', bidClosingAt: '2026-11-01T08:00:00Z' },
      { bidOpeningAt: '2026-11-01T08:00:00Z' },
      { procurementNature: 'AUCTION' },
    ]) {
      const response = await http()
        .post(`/v1/projects/${project.id}/tenders`)
        .set(as(token))
        .send({ ...TENDER, ...bad });
      expect(response.status).toBe(400);
    }
    const emptyKey = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set({ ...as(token), 'idempotency-key': ' ' })
      .send(TENDER);
    expect(emptyKey.status).toBe(400);
    expect((await http().get('/v1/tenders?status=BID_OPEN').set(as(token))).status).toBe(400);
  });

  it('replays an idempotent create and refuses the same key with another body', async () => {
    const a = org('idem');
    const project = await approvedProject(w, a);
    const headers = { ...as(orgAdmin(a)), 'idempotency-key': 'api-tender-key-1' };

    const first = await http().post(`/v1/projects/${project.id}/tenders`).set(headers).send(TENDER);
    const again = await http().post(`/v1/projects/${project.id}/tenders`).set(headers).send(TENDER);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.id).toBe(first.body.id);

    const other = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(headers)
      .send({ ...TENDER, title: 'Another' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a tender under a project that is not APPROVED (422), and one that does not exist (404)', async () => {
    const a = org('state');
    const token = orgAdmin(a);
    const draft = await http().post('/v1/projects').set(as(token)).send(PROJECT);

    const refused = await http()
      .post(`/v1/projects/${draft.body.id as string}/tenders`)
      .set(as(token))
      .send(TENDER);
    expect(refused.status).toBe(422);
    expect(
      (await http().post('/v1/projects/PRJ_missing/tenders').set(as(token)).send(TENDER)).status,
    ).toBe(404);
  });

  it('answers 404 to another organization on every route, and lists nothing of the first', async () => {
    const a = org('owner');
    const b = org('stranger');
    const project = await approvedProject(w, a);
    const tender = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(orgAdmin(a)))
      .send(TENDER);
    const id = tender.body.id as string;
    const stranger = as(orgAdmin(b));

    expect((await http().get(`/v1/tenders/${id}`).set(stranger)).status).toBe(404);
    expect(
      (
        await http()
          .patch(`/v1/tenders/${id}`)
          .set(stranger)
          .send({ expectedVersion: 1, title: 'Hijacked' })
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .post(`/v1/tenders/${id}/cancel`)
          .set(stranger)
          .send({ expectedVersion: 1, reason: 'Cross-tenant attempt' })
      ).status,
    ).toBe(404);
    expect(
      (await http().post(`/v1/projects/${project.id}/tenders`).set(stranger).send(TENDER)).status,
    ).toBe(404);

    const list = await http().get('/v1/tenders').set(stranger);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);

    const unchanged = await http()
      .get(`/v1/tenders/${id}`)
      .set(as(orgAdmin(a)));
    expect(unchanged.body).toMatchObject({ version: 1, status: 'DRAFT' });
  });
});
