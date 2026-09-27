import request from 'supertest';
import { actor, apiTenant, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { PROJECT, cleanup } from './helpers';

/**
 * The CON-001 PR 2 surface through the real application: guards, filter,
 * versioning and database are all real. One project walks the whole
 * lifecycle — policy, request, a decision by another organization's
 * authority, start, progress, completion — and each refusal on the way
 * carries its documented status.
 */

describe('construction HTTP API — approvals, execution and progress', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  const tenant = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };
  const http = () => request(api.app.getHttpServer());
  const setter = (org: string) => actor(org, ['UNION_ADMIN']);
  const platform = () => actor('ORG-APITEST-PLATFORM', ['SYSTEM_ADMIN']);

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  /**
   * A policy for `org`, the decided way (Q-70 (7)): written and submitted by
   * the administrator of the union `org` sits under, approved by a platform
   * administrator.
   */
  async function policyFor(
    org: string,
    authorityOrganizationId: string,
    workflowKey = 'project.execution',
  ) {
    const union = tenant('UNION');
    api.hierarchy.adopt(union, org);
    const created = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${setter(union)}`)
      .send({
        organizationId: org,
        workflowKey,
        label: 'Council approval',
        rationale: 'Resolution recorded by the council',
        isSample: true,
        steps: [
          {
            approvalType: 'Council approval',
            authorityOrganizationId,
            authorityRole: 'ORGANIZATION_ADMIN',
            authorityLabel: 'Village council',
          },
        ],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      organizationId: org,
      authorOrganizationId: union,
      authorRole: 'UNION_ADMIN',
    });
    await http()
      .post(`/v1/approval-policies/${created.body.id}/submit`)
      .set('authorization', `Bearer ${setter(union)}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    await http()
      .post(`/v1/approval-policies/${created.body.id}/approve`)
      .set('authorization', `Bearer ${platform()}`)
      .send({ expectedVersion: 2 })
      .expect(200);
    return created.body.id as string;
  }

  async function readyProject(org: string): Promise<{ id: string; version: number }> {
    const token = orgAdmin(org);
    const project = await http()
      .post('/v1/projects')
      .set('authorization', `Bearer ${token}`)
      .send({ ...PROJECT, estimatedCostMinor: '5000000' })
      .expect(201);
    const need = await http()
      .post(`/v1/projects/${project.body.id}/needs`)
      .set('authorization', `Bearer ${token}`)
      .send({ title: 'Gravel', description: 'Base course' })
      .expect(201);
    await http()
      .post(`/v1/projects/${project.body.id}/needs/${need.body.id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    return { id: project.body.id, version: project.body.version };
  }

  it('walks policy → request → authority decision → start → progress → completion', async () => {
    const org = tenant('LIFE');
    const council = tenant('COUNCIL');
    const token = orgAdmin(org);
    const councillor = orgAdmin(council);

    await policyFor(org, council);
    const project = await readyProject(org);

    const requested = await http()
      .post(`/v1/projects/${project.id}/approvals`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: project.version })
      .expect(200);
    expect(requested.body.status).toBe('PENDING_APPROVAL');

    const steps = await http()
      .get(`/v1/projects/${project.id}/approvals`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(steps.body).toHaveLength(1);
    const approvalId = steps.body[0].id as string;

    // The project's own administrator may see the step but not decide it.
    const refused = await http()
      .post(`/v1/approvals/${approvalId}/decision`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1, decision: 'GRANT' })
      .expect(403);
    expect(refused.body.code).toBe('FORBIDDEN');

    // A stranger learns nothing.
    await http()
      .get(`/v1/approvals/${approvalId}`)
      .set('authorization', `Bearer ${orgAdmin(tenant('STRANGER'))}`)
      .expect(404);

    const inbox = await http()
      .get('/v1/approvals')
      .set('authorization', `Bearer ${councillor}`)
      .expect(200);
    expect(inbox.body.items.map((item: { id: string }) => item.id)).toEqual([approvalId]);

    const granted = await http()
      .post(`/v1/approvals/${approvalId}/decision`)
      .set('authorization', `Bearer ${councillor}`)
      .send({ expectedVersion: 1, decision: 'GRANT', decisionNumber: '1405-12' })
      .expect(200);
    expect(granted.body).toMatchObject({ status: 'GRANTED', project: { status: 'APPROVED' } });

    const approved = await http()
      .get(`/v1/projects/${project.id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    const started = await http()
      .post(`/v1/projects/${project.id}/start`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: approved.body.version })
      .expect(200);
    expect(started.body.status).toBe('IN_PROGRESS');

    const draft = await http()
      .post(`/v1/projects/${project.id}/progress`)
      .set('authorization', `Bearer ${token}`)
      .send({ progressBasisPoints: 10_000, machinery: 'Two loaders' })
      .expect(201);
    await http()
      .post(`/v1/projects/${project.id}/progress/${draft.body.id}/submit`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const reports = await http()
      .get(`/v1/projects/${project.id}/progress`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(reports.body.items[0]).toMatchObject({
      status: 'SUBMITTED',
      progressBasisPoints: 10_000,
    });

    const completed = await http()
      .post(`/v1/projects/${project.id}/complete`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: started.body.version })
      .expect(200);
    expect(completed.body.status).toBe('COMPLETED');
  });

  it('refuses a request with no active policy (422): the platform never approves by default', async () => {
    const org = tenant('NOPOLICY');
    const project = await readyProject(org);
    const response = await http()
      .post(`/v1/projects/${project.id}/approvals`)
      .set('authorization', `Bearer ${orgAdmin(org)}`)
      .send({ expectedVersion: project.version })
      .expect(422);
    expect(response.body.message).toMatch(/never approves by default/);
  });

  it('writes, submits, approves and rejects policies as decided (Q-70 (7))', async () => {
    const org = tenant('POLICY');
    const union = tenant('POLICY-UNION');
    api.hierarchy.adopt(union, org);
    const body = {
      organizationId: org,
      workflowKey: 'project.execution',
      label: 'Council approval',
      rationale: 'Resolution recorded by the council',
      steps: [
        {
          approvalType: 'Council approval',
          authorityOrganizationId: org,
          authorityRole: 'ORGANIZATION_ADMIN',
          authorityLabel: 'Council',
        },
      ],
    };

    // The organization's own administrator never writes its policy.
    const own = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${orgAdmin(org)}`)
      .send(body)
      .expect(403);
    expect(own.body.code).toBe('INSUFFICIENT_ROLE');

    // A union not above the organization is refused, without learning why.
    const stranger = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${setter(tenant('OTHER-UNION'))}`)
      .send(body)
      .expect(403);
    expect(stranger.body.code).toBe('FORBIDDEN');

    // The union above it writes; the policy governs nothing until approved.
    const created = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${setter(union)}`)
      .send(body)
      .expect(201);
    await http()
      .post(`/v1/approval-policies/${created.body.id}/submit`)
      .set('authorization', `Bearer ${setter(union)}`)
      .send({ expectedVersion: 1 })
      .expect(200);

    // Only a platform administrator decides; the union cannot approve its own.
    await http()
      .post(`/v1/approval-policies/${created.body.id}/approve`)
      .set('authorization', `Bearer ${setter(union)}`)
      .send({ expectedVersion: 2 })
      .expect(403);
    const queue = await http()
      .get('/v1/approval-policies/pending-platform-approval')
      .set('authorization', `Bearer ${platform()}`)
      .expect(200);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(created.body.id);
    const rejected = await http()
      .post(`/v1/approval-policies/${created.body.id}/reject`)
      .set('authorization', `Bearer ${platform()}`)
      .send({ expectedVersion: 2, reason: 'The authority is not named precisely' })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'The authority is not named precisely',
    });

    // The governed organization reads it; an unrelated organization does not.
    await http()
      .get(`/v1/approval-policies/${created.body.id}`)
      .set('authorization', `Bearer ${orgAdmin(org)}`)
      .expect(200);
    await http()
      .get(`/v1/approval-policies/${created.body.id}`)
      .set('authorization', `Bearer ${setter(tenant('POLICY-OTHER'))}`)
      .expect(404);

    const policyId = await policyFor(org, org);
    const list = await http()
      .get('/v1/approval-policies')
      .set('authorization', `Bearer ${orgAdmin(org)}`)
      .expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([policyId, created.body.id]),
    );
  });

  it('holds a platform administrator to four eyes on its own policy', async () => {
    const org = tenant('FOUR-EYES');
    const author = actor('ORG-APITEST-PLATFORM', ['SYSTEM_ADMIN']);
    const created = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${author}`)
      .send({
        organizationId: org,
        workflowKey: 'project.execution',
        label: 'Platform-written policy',
        rationale: 'Written directly by the platform administrator',
        steps: [
          {
            approvalType: 'Council approval',
            authorityOrganizationId: org,
            authorityRole: 'ORGANIZATION_ADMIN',
            authorityLabel: 'Council',
          },
        ],
      })
      .expect(201);
    expect(created.body.authorRole).toBe('SYSTEM_ADMIN');
    await http()
      .post(`/v1/approval-policies/${created.body.id}/submit`)
      .set('authorization', `Bearer ${author}`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const self = await http()
      .post(`/v1/approval-policies/${created.body.id}/approve`)
      .set('authorization', `Bearer ${author}`)
      .send({ expectedVersion: 2 })
      .expect(403);
    expect(self.body.message).toMatch(/different platform administrator/);
    await http()
      .post(`/v1/approval-policies/${created.body.id}/approve`)
      .set('authorization', `Bearer ${platform()}`)
      .send({ expectedVersion: 2 })
      .expect(200);
  });

  it('refuses the oversight role on the new routes', async () => {
    const org = tenant('AUD2');
    const auditor = actor(org, ['AUDITOR']);
    await http().get('/v1/approvals').set('authorization', `Bearer ${auditor}`).expect(403);
    await http().get('/v1/approval-policies').set('authorization', `Bearer ${auditor}`).expect(403);
  });
});
