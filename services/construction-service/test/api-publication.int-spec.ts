import request from 'supertest';
import {
  reasonsOf,
  actor,
  apiTenant,
  auditorActor,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { activatePublicationPolicy, approvedProject, cleanup, wire, type Wiring } from './helpers';

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

  it('refuses a complete tender with no active tender.publication policy (422 APPROVAL_POLICY_REQUIRED): fail closed', async () => {
    const a = org('publish');
    const { id, version, token } = await tenderFor(a);

    const refused = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });

    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(refused.body.message).toContain('APPROVAL_POLICY_REQUIRED');
    const now = await http().get(`/v1/tenders/${id}`).set(as(token));
    expect(now.body).toMatchObject({ status: 'DRAFT', version, publishedAt: null });

    const stale = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
  });

  it('with a policy in force answers 202 with the request, publishes only once another person approved it, and only once', async () => {
    const a = org('publish-policy');
    const { id, version, token } = await tenderFor(a);
    await activatePublicationPolicy(w, a);
    const publish = (as_: string) =>
      http().post(`/v1/tenders/${id}/publish`).set(as(as_)).send({ expectedVersion: version });

    const asked = await publish(token);
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({
      workflowKey: 'tender.publication',
      tenderId: id,
      tenderVersion: version,
      status: 'PENDING',
    });
    expect((await http().get(`/v1/tenders/${id}`).set(as(token))).body.status).toBe('DRAFT');
    const listed = await http().get(`/v1/tenders/${id}/approvals`).set(as(token));
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((r: { id: string }) => r.id)).toEqual([asked.body.id]);

    // The same command again, still undecided: the same request.
    expect((await publish(token)).body.id).toBe(asked.body.id);

    // The person who asked does not approve (403); somebody else does (200) and the step is granted.
    const stepId = asked.body.steps[0].approvalId as string;
    const decision = (as_: string, expectedVersion: number) =>
      http()
        .post(`/v1/approvals/${stepId}/decision`)
        .set(as(as_))
        .send({ decision: 'GRANT', expectedVersion });
    const step = await http().get(`/v1/approvals/${stepId}`).set(as(token));
    expect(step.status).toBe(200);
    expect(step.body).toMatchObject({ tenderId: id, workflowKey: 'tender.publication' });
    const own = await decision(token, step.body.version);
    expect(own.status).toBe(403);
    expect(own.body.message).toContain('Separation of duties');
    const granted = await decision(orgAdmin(a), step.body.version);
    expect(granted.status).toBe(200);
    expect(granted.body.status).toBe('GRANTED');

    const published = await publish(token);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', version: version + 1 });
    // Used once: the same command is now a stale one.
    expect((await publish(token)).status).toBe(409);
  });

  it('answers 409 APPROVAL_STALE when the tender changed after the approval, and publishes nothing', async () => {
    const a = org('publish-stale');
    const { id, version, token } = await tenderFor(a);
    await activatePublicationPolicy(w, a);
    const asked = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });
    const stepId = asked.body.steps[0].approvalId as string;
    const step = await http().get(`/v1/approvals/${stepId}`).set(as(token));
    await http()
      .post(`/v1/approvals/${stepId}/decision`)
      .set(as(orgAdmin(a)))
      .send({ decision: 'GRANT', expectedVersion: step.body.version });
    const edited = await http()
      .patch(`/v1/tenders/${id}`)
      .set(as(token))
      .send({ expectedVersion: version, title: 'Edited after approval' });
    expect(edited.status).toBe(200);

    const stale = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: edited.body.version });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain('APPROVAL_STALE');
    expect(stale.body.code).toBe('CONFLICT');
    expect(reasonsOf(stale.body)).toEqual(['approval:APPROVAL_STALE']);
    expect((await http().get(`/v1/tenders/${id}`).set(as(token))).body.status).toBe('DRAFT');
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
    // Every reason, each its own entry of `details`, in the order the message names them.
    expect(reasonsOf(refused.body)).toEqual([
      'publication:CRITERIA_WEIGHTS_INCOMPLETE',
      'publication:INVITATION_REQUIRED',
    ]);
    expect(refused.body.details[0].message).toBe(
      'Tender cannot be published: CRITERIA_WEIGHTS_INCOMPLETE',
    );
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

    // Publishing is the gate's to refuse until the round is wired (PR 11): the
    // invited restricted tender is complete and still stays a DRAFT.
    const published = await http()
      .post(`/v1/tenders/${id}/publish`)
      .set(as(token))
      .send({ expectedVersion: version });
    expect(published.status).toBe(422);
    expect(published.body.message).toContain('APPROVAL_POLICY_REQUIRED');
    expect(published.body.message).not.toContain('INVITATION_REQUIRED');
    expect(reasonsOf(published.body)).toEqual(['publication:APPROVAL_POLICY_REQUIRED']);

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
    expect((await http().get(`/v1/tenders/${id}/approvals`).set(stranger)).status).toBe(404);
  });
});
