import { test, expect, errorCode, type Actor } from '../../src/api';
import { ORG, e2eConfig } from '../../src/env';
import { EconomicEventTap } from '../../src/events';

/**
 * The core construction project lifecycle, end to end (CON-001, `docs/08`
 * § 8.3), under the approval-policy rule the project owner decided on
 * 2026-09-26 (Q-70 (7)): a union writes the policy, the platform approves it.
 *
 * Through the real thing: Keycloak tokens, api-gateway, construction-service,
 * organization-service (the hierarchy), PostgreSQL and Kafka. Nothing stubbed.
 *
 * ## Who plays which part
 *
 * - `platformAdmin` (`union.admin`, `ORG-UNION-YAZD`, `UNION_ADMIN`) writes and
 *   submits the policies. In the seeded tree no dehyari is beneath the union
 *   (they sit under `ORG-COUNTY-YAZD`), so the union writes for its own
 *   organization — and is refused, by organization-service's real answer,
 *   for `ORG-DEH-0001`.
 * - `systemAdmin` (`system.admin`, `SYSTEM_ADMIN` of `ORG-UNION-YAZD`) approves
 *   the policies — a different person from their author (four eyes) — and
 *   owns the project, as SYSTEM_ADMIN acting for its organization.
 * - `tenantA` (`dehyari.admin`, `ORG-DEH-0001`, `ORGANIZATION_ADMIN`) is the
 *   authority both policies name: another organization's administrator
 *   deciding the step addressed to it. As an organization administrator it may
 *   not write a policy at all.
 * - `tenantB` learns nothing; `auditor` reaches nothing.
 *
 * The policies are marked `isSample` and claim no real legal authority
 * (ADR-023): which body actually approves a project stays open (Q-02).
 */

const config = e2eConfig();

interface ProjectBody {
  id: string;
  status: string;
  version: number;
}

interface PolicyBody {
  id: string;
  status: string;
  version: number;
  organizationId: string;
  authorOrganizationId: string;
  authorRole: string;
  workflowKey: string;
}

interface ApprovalBody {
  id: string;
  status: string;
  version: number;
  workflowKey: string;
  round: number;
  stepOrder: number;
  authorityOrganizationId: string;
  authorityRole: string;
  projectId: string;
  project: { status: string };
}

const policyBody = (organizationId: string, workflowKey: string, approvalType: string) => ({
  organizationId,
  workflowKey,
  label: `E2E sample — ${approvalType}`,
  rationale: 'Written by the E2E suite; a sample, not an adopted procedure',
  isSample: true,
  steps: [
    {
      approvalType,
      authorityOrganizationId: ORG.a,
      authorityRole: 'ORGANIZATION_ADMIN',
      authorityLabel: 'Dehyari administrator (sample)',
    },
  ],
});

async function project(owner: Actor, projectId: string): Promise<ProjectBody> {
  const response = await owner.get(`/v1/projects/${projectId}`);
  expect(response.status).toBe(200);
  return response.body as ProjectBody;
}

async function pendingStep(
  owner: Actor,
  projectId: string,
  workflowKey: string,
): Promise<ApprovalBody> {
  const response = await owner.get(`/v1/projects/${projectId}/approvals`);
  expect(response.status).toBe(200);
  const pending = (response.body as ApprovalBody[]).filter(
    (step) => step.workflowKey === workflowKey && step.status === 'PENDING',
  );
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

test.describe.serial('the construction project lifecycle', () => {
  let tap: EconomicEventTap;
  let projectId: string;
  const policies: Record<'execution' | 'completion', PolicyBody | undefined> = {
    execution: undefined,
    completion: undefined,
  };

  test.beforeAll(async () => {
    tap = await EconomicEventTap.start(config, config.constructionTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
  });

  test('an earlier run’s policies are taken out of force, so this run starts clean', async ({
    platformAdmin,
  }) => {
    // CI starts from an empty database; a developer's re-run does not.
    const active = await platformAdmin.get('/v1/approval-policies?status=ACTIVE&limit=100');
    expect(active.status).toBe(200);
    for (const policy of (active.body as { items: PolicyBody[] }).items) {
      if (policy.organizationId !== ORG.platform) continue;
      const retired = await platformAdmin.post(`/v1/approval-policies/${policy.id}/retire`, {
        body: { expectedVersion: policy.version },
      });
      expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    }
  });

  test('only a union writes a policy, and only for an organization under it', async ({
    tenantA,
    platformAdmin,
  }) => {
    // An organization administrator never writes its own policy.
    const own = await tenantA.post('/v1/approval-policies', {
      body: policyBody(ORG.a, 'project.execution', 'Execution approval (sample)'),
    });
    expect(own.status).toBe(403);
    expect(errorCode(own.body)).toBe('INSUFFICIENT_ROLE');

    // The union is not above ORG-DEH-0001 in the seeded tree: organization-
    // service answers 404 to construction-service, and the write is refused.
    const outside = await platformAdmin.post('/v1/approval-policies', {
      body: policyBody(ORG.a, 'project.execution', 'Execution approval (sample)'),
    });
    expect(outside.status, JSON.stringify(outside.body)).toBe(403);
    expect(errorCode(outside.body)).toBe('FORBIDDEN');

    // For its own organization it writes, and submits for platform approval.
    for (const [key, workflowKey, approvalType] of [
      ['execution', 'project.execution', 'Execution approval (sample)'],
      ['completion', 'project.completion', 'Final technical approval (sample)'],
    ] as const) {
      const created = await platformAdmin.post('/v1/approval-policies', {
        body: policyBody(ORG.platform, workflowKey, approvalType),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({
        status: 'DRAFT',
        organizationId: ORG.platform,
        authorOrganizationId: ORG.platform,
        authorRole: 'UNION_ADMIN',
      });
      const submitted = await platformAdmin.post(
        `/v1/approval-policies/${(created.body as PolicyBody).id}/submit`,
        { body: { expectedVersion: 1 } },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      policies[key] = submitted.body as PolicyBody;
    }
  });

  test('a pending policy governs nothing: the request is refused', async ({ systemAdmin }) => {
    const created = await systemAdmin.post('/v1/projects', {
      body: {
        title: 'بهسازی راه روستایی',
        operationType: 'road',
        scopeOfWork: 'Resurfacing of the main village road',
        locationDescription: 'Main road, north entrance',
        estimatedCostMinor: '5000000000',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = (created.body as ProjectBody).id;

    const need = await systemAdmin.post(`/v1/projects/${projectId}/needs`, {
      body: { title: 'Gravel', description: 'Base course for two kilometres' },
    });
    expect(need.status, JSON.stringify(need.body)).toBe(201);
    const submitted = await systemAdmin.post(
      `/v1/projects/${projectId}/needs/${(need.body as { id: string }).id}/submit`,
      { body: { expectedVersion: 1 } },
    );
    expect(submitted.status).toBe(200);

    const refused = await systemAdmin.post(`/v1/projects/${projectId}/approvals`, {
      body: { expectedVersion: (created.body as ProjectBody).version },
    });
    expect(refused.status).toBe(422);
    expect((refused.body as { message: string }).message).toMatch(/never approves by default/);
  });

  test('the platform administrator approves; the union cannot approve its own', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    const execution = policies.execution!;
    const byAuthor = await platformAdmin.post(`/v1/approval-policies/${execution.id}/approve`, {
      body: { expectedVersion: execution.version },
    });
    expect(byAuthor.status).toBe(403);

    const queue = await systemAdmin.get('/v1/approval-policies/pending-platform-approval');
    expect(queue.status).toBe(200);
    expect((queue.body as { items: PolicyBody[] }).items.map((item) => item.id)).toEqual(
      expect.arrayContaining([execution.id, policies.completion!.id]),
    );

    for (const policy of [execution, policies.completion!]) {
      const approved = await systemAdmin.post(`/v1/approval-policies/${policy.id}/approve`, {
        body: { expectedVersion: policy.version },
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ status: 'ACTIVE' });
    }
  });

  test('the project now asks for approval under the approved policy', async ({ systemAdmin }) => {
    const current = await project(systemAdmin, projectId);
    const requested = await systemAdmin.post(`/v1/projects/${projectId}/approvals`, {
      body: { expectedVersion: current.version },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect((requested.body as ProjectBody).status).toBe('PENDING_APPROVAL');

    const step = await pendingStep(systemAdmin, projectId, 'project.execution');
    expect(step).toMatchObject({
      round: 1,
      stepOrder: 1,
      authorityOrganizationId: ORG.a,
      authorityRole: 'ORGANIZATION_ADMIN',
    });
  });

  test('nobody but the named authority decides', async ({
    systemAdmin,
    platformAdmin,
    tenantB,
    auditor,
  }) => {
    const step = await pendingStep(systemAdmin, projectId, 'project.execution');
    const grant = { body: { expectedVersion: step.version, decision: 'GRANT' } };

    // The project's own organization (SYSTEM_ADMIN acting for it) sees the step
    // and is told it may not decide: the platform decides nothing.
    const owner = await systemAdmin.post(`/v1/approvals/${step.id}/decision`, grant);
    expect(owner.status).toBe(403);
    expect(errorCode(owner.body)).toBe('FORBIDDEN');

    // The union that wrote the policy is not its authority either.
    expect((await platformAdmin.post(`/v1/approvals/${step.id}/decision`, grant)).status).toBe(404);

    // Another tenant learns nothing.
    expect((await tenantB.get(`/v1/approvals/${step.id}`)).status).toBe(404);
    expect((await tenantB.post(`/v1/approvals/${step.id}/decision`, grant)).status).toBe(404);
    expect((await tenantB.get(`/v1/projects/${projectId}`)).status).toBe(404);

    // Oversight reaches nothing here.
    expect((await auditor.get('/v1/approvals')).status).toBe(403);
    expect((await auditor.get('/v1/approval-policies')).status).toBe(403);

    expect(await pendingStep(systemAdmin, projectId, 'project.execution')).toMatchObject({
      id: step.id,
      version: step.version,
    });
  });

  test('the authority finds the step in its inbox and grants it', async ({
    systemAdmin,
    tenantA,
  }) => {
    const step = await pendingStep(systemAdmin, projectId, 'project.execution');

    const inbox = await tenantA.get('/v1/approvals?status=PENDING&limit=100');
    expect(inbox.status).toBe(200);
    expect((inbox.body as { items: ApprovalBody[] }).items.map((item) => item.id)).toContain(
      step.id,
    );

    const granted = await tenantA.post(`/v1/approvals/${step.id}/decision`, {
      body: { expectedVersion: step.version, decision: 'GRANT', decisionNumber: 'E2E-1' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({
      status: 'GRANTED',
      projectId,
      project: { status: 'APPROVED' },
    });
  });

  test('the approved project starts and reports full progress', async ({ systemAdmin }) => {
    const approved = await project(systemAdmin, projectId);
    const started = await systemAdmin.post(`/v1/projects/${projectId}/start`, {
      body: { expectedVersion: approved.version },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((started.body as ProjectBody).status).toBe('IN_PROGRESS');

    const draft = await systemAdmin.post(`/v1/projects/${projectId}/progress`, {
      body: {
        progressBasisPoints: 10_000,
        materials: 'Gravel and asphalt delivered',
        machinery: 'Two loaders, one roller',
        labor: 'Six workers',
      },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const report = draft.body as { id: string; version: number; status: string };
    expect(report.status).toBe('DRAFT');

    const submitted = await systemAdmin.post(
      `/v1/projects/${projectId}/progress/${report.id}/submit`,
      { body: { expectedVersion: report.version } },
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED', progressBasisPoints: 10_000 });
  });

  test('completion waits for the final technical approval, then completes', async ({
    systemAdmin,
    tenantA,
  }) => {
    const running = await project(systemAdmin, projectId);
    const asked = await systemAdmin.post(`/v1/projects/${projectId}/complete`, {
      body: { expectedVersion: running.version },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect((asked.body as ProjectBody).status).toBe('IN_PROGRESS');

    const step = await pendingStep(systemAdmin, projectId, 'project.completion');
    expect(step.round).toBe(2);

    const correlationId = `e2e-con-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;
    const granted = await tenantA.post(`/v1/approvals/${step.id}/decision`, {
      correlationId,
      body: { expectedVersion: step.version, decision: 'GRANT' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({ project: { status: 'COMPLETED' } });
    expect((await project(systemAdmin, projectId)).status).toBe('COMPLETED');

    // The decision reached Kafka through the outbox, under the project's key
    // and tenant, carrying the correlation id of the HTTP call.
    const events = await tap.awaitCorrelated(correlationId, [
      'APPROVAL_GRANTED',
      'PROJECT_COMPLETED',
    ]);
    for (const event of events) {
      expect(event.correlationId).toBe(correlationId);
      expect(event.envelopeCorrelationId).toBe(correlationId);
      expect(event.tenantId).toBe(ORG.platform);
      expect(event.key).toBe(projectId);
    }
    const completed = events.find((event) => event.eventName === 'PROJECT_COMPLETED');
    expect(completed!.payload).toMatchObject({ projectId, organizationId: ORG.platform });
  });
});
