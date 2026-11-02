import request from 'supertest';
import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  ProjectCompletionService,
  projectCompletionFactSchema,
} from '../src/project/completion-fact';
import { buildConstructionOpenApiDocument } from '../src/openapi/document';
import { actor, internalToken, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import {
  activePolicy,
  approvedProject,
  approvalsOf,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  PROJECT,
  wire,
  type Wiring,
} from './helpers';

describe('the internal project completion source read (D-081)', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const http = () => request(api.app.getHttpServer());
  const read = async (id: string, organizationId: string) =>
    http()
      .get(`/v1/internal/projects/${id}/completion`)
      .set('x-internal-token', await internalToken('contract-service', { organizationId }));

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });
  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
    await api.close();
  });

  it.each([false, true])(
    'states the stored completion fact, configured final approval = %s',
    async (configured) => {
      const owner = org();
      const project = await approvedProject(w, owner);
      await asAdmin(owner, () =>
        w.execution.start(project.id, { expectedVersion: project.version }),
      );
      const draft = await asAdmin(owner, () =>
        w.progress.draft(project.id, { progressBasisPoints: 10000, assetsUsed: [] }),
      );
      await asAdmin(owner, () => w.progress.submit(project.id, draft.id, { expectedVersion: 1 }));
      if (configured)
        await activePolicy(w, owner, [{ authorityOrganizationId: owner }], 'project.completion');
      const current = await asAdmin(owner, () => w.projects.get(project.id));
      const asked = await asAdmin(owner, () =>
        w.execution.complete(project.id, { expectedVersion: current.version }),
      );
      if (configured) {
        const pending = await read(project.id, owner);
        expect(pending.status).toBe(200);
        expect(pending.body).toMatchObject({
          status: 'IN_PROGRESS',
          completedAt: null,
          completedBy: null,
        });
        const step = (await approvalsOf(w, owner, project.id)).find(
          (s) => s.workflowKey === 'project.completion',
        )!;
        await asAdmin(owner, () =>
          w.approvals.decide(step.id, { expectedVersion: step.version, decision: 'GRANT' }),
        );
      } else expect(asked.status).toBe('COMPLETED');
      const completed = await asAdmin(owner, () => w.projects.get(project.id));
      const eventsBefore = await outboxFor(w.prisma, owner);
      const response = await read(project.id, owner);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        projectId: project.id,
        organizationId: owner,
        status: 'COMPLETED',
        version: completed.version,
        completedAt: completed.statusChangedAt,
        completedBy: completed.statusChangedBy,
      });
      expect(projectCompletionFactSchema.safeParse(response.body).success).toBe(true);
      const envelope = eventEnvelopeSchema.parse(
        eventsBefore.find((e) => e.eventName === 'PROJECT_COMPLETED')!.payload,
      );
      expect(envelope.tenantId).toBe(owner);
      expect(envelope.payload).toEqual({
        projectId: project.id,
        organizationId: owner,
        completedAt: response.body.completedAt,
        completedBy: response.body.completedBy,
      });
      expect((await read(project.id, owner)).body).toEqual(response.body);
      expect(await outboxFor(w.prisma, owner)).toEqual(eventsBefore);
    },
  );

  it('does not turn draft or cancelled metadata into completion proof', async () => {
    const owner = org();
    const project = await asAdmin(owner, () => w.projects.create(PROJECT));
    expect((await read(project.id, owner)).body).toMatchObject({
      status: 'DRAFT',
      completedAt: null,
      completedBy: null,
    });
    await asAdmin(owner, () =>
      w.projects.cancel(project.id, { expectedVersion: 1, reason: 'Withdrawn' }),
    );
    expect((await read(project.id, owner)).body).toMatchObject({
      status: 'CANCELLED',
      completedAt: null,
      completedBy: null,
    });
  });

  it('uses the signed tenant: other-tenant and missing projects are indistinguishable', async () => {
    const owner = org(),
      stranger = org();
    const project = await asAdmin(owner, () => w.projects.create(PROJECT));
    for (const id of [project.id, 'PRJ_MISSING']) {
      const result = await read(id, stranger);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ code: 'NOT_FOUND', message: 'Project not found' });
    }
    const conflict = await http()
      .get(`/v1/internal/projects/${project.id}/completion`)
      .set(
        'x-internal-token',
        await internalToken('contract-service', { organizationId: stranger }),
      )
      .set('x-organization-id', owner);
    expect(conflict.status).toBe(403);
    expect(conflict.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
  });

  it('refuses all user roles, including a user also supplying the allowed service token', async () => {
    const owner = org();
    const project = await asAdmin(owner, () => w.projects.create(PROJECT));
    for (const roles of [['ORGANIZATION_ADMIN'], ['SYSTEM_ADMIN'], ['AUDITOR'], ['CONTRACTOR']]) {
      const result = await http()
        .get(`/v1/internal/projects/${project.id}/completion`)
        .set('authorization', `Bearer ${actor(owner, roles)}`)
        .set(
          'x-internal-token',
          await internalToken('contract-service', { organizationId: owner }),
        );
      expect(result.status).toBe(403);
    }
    expect(
      (
        await http()
          .get(`/v1/internal/projects/${project.id}/completion`)
          .set('authorization', `Bearer ${orgAdmin(owner)}`)
      ).status,
    ).toBe(403);
  });

  it('refuses other services, relay-purpose tokens, missing tenant and unauthenticated calls', async () => {
    const owner = org();
    const path = '/v1/internal/projects/PRJ_MISSING/completion';
    for (const caller of ['economic-service', 'api-gateway']) {
      expect(
        (
          await http()
            .get(path)
            .set('x-internal-token', await internalToken(caller, { organizationId: owner }))
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await http()
          .get(path)
          .set('x-internal-token', await internalToken('contract-service'))
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .get(path)
          .set(
            'x-internal-token',
            await internalToken('contract-service', { organizationId: owner, purpose: 'RELAY' }),
          )
      ).status,
    ).toBe(401);
    expect((await http().get(path)).status).toBe(401);
  });

  it('documents the runtime route with internal-token security and its actual success schema', () => {
    const operation = buildConstructionOpenApiDocument(api.app).paths[
      '/v1/internal/projects/{id}/completion'
    ]!.get!;
    expect(operation.security).toEqual([{ internalToken: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '401',
      '403',
      '404',
      '500',
    ]);
    expect(api.app.get(ProjectCompletionService)).toBeInstanceOf(ProjectCompletionService);
  });
});
