import { test, expect, errorCode, type Actor } from '../../src/api';
import { ORG, e2eConfig } from '../../src/env';
import { EconomicEventTap } from '../../src/events';

/**
 * The core construction project lifecycle, end to end (CON-001, `docs/08`
 * § 8.3): a project with a need, an approval policy read from configuration,
 * a request, a decision by the authority the policy names, the start, a
 * progress report, and completion under a final technical approval.
 *
 * Through the real thing: Keycloak tokens, api-gateway, construction-service,
 * PostgreSQL and Kafka. Nothing is stubbed.
 *
 * ## Who plays which part
 *
 * - `tenantA` (`ORG-DEH-0001`, `ORGANIZATION_ADMIN`) owns the project and
 *   writes its organization's approval policies.
 * - `platformAdmin` (`ORG-UNION-YAZD`, `UNION_ADMIN`) is the authority both
 *   policies name. The policy rows are written by this suite, marked
 *   `isSample`, and claim no real legal authority (ADR-023): which body
 *   actually approves a project is Q-02/Q-70 and stays open.
 * - `systemAdmin` sits in the authority's organization with `SYSTEM_ADMIN`
 *   and still cannot decide: the platform decides nothing.
 * - `tenantB` learns nothing; `auditor` reaches nothing.
 *
 * `tenantA` writing its own policy needs a deployment choice: the default
 * `CONSTRUCTION_POLICY_SETTER_ROLES` is `SYSTEM_ADMIN,UNION_ADMIN`, and no
 * seeded organization holds both a project role and a setter role, so the
 * E2E job runs construction-service with `ORGANIZATION_ADMIN` added (Q-70 (7),
 * provisional and configurable). Who writes a village's policy is exactly what
 * that question asks the owner.
 *
 * Every write names the version it read. Policies are activated fresh each
 * run — activation retires the previous one — so the suite repeats on a
 * database that holds earlier runs.
 */

const config = e2eConfig();

interface ProjectBody {
  id: string;
  status: string;
  version: number;
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

/** Creates and activates a sample policy with one step naming the union administrator. */
async function activatePolicy(
  owner: Actor,
  workflowKey: 'project.execution' | 'project.completion',
  approvalType: string,
): Promise<string> {
  const created = await owner.post('/v1/approval-policies', {
    body: {
      workflowKey,
      label: `E2E sample — ${approvalType}`,
      rationale: 'Written by the E2E suite; a sample, not an adopted procedure',
      isSample: true,
      steps: [
        {
          approvalType,
          authorityOrganizationId: ORG.platform,
          authorityRole: 'UNION_ADMIN',
          authorityLabel: 'Union administrator (sample)',
        },
      ],
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const policy = created.body as { id: string; version: number; status: string };
  expect(policy.status).toBe('DRAFT');

  const activated = await owner.post(`/v1/approval-policies/${policy.id}/activate`, {
    body: { expectedVersion: policy.version },
  });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  expect((activated.body as { status: string }).status).toBe('ACTIVE');
  return policy.id;
}

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

  test.beforeAll(async () => {
    // The same tap the other domains use, pointed at this domain's topic.
    tap = await EconomicEventTap.start(config, config.constructionTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
  });

  test('the owner configures who approves execution and completion', async ({ tenantA }) => {
    await activatePolicy(tenantA, 'project.execution', 'Execution approval (sample)');
    await activatePolicy(tenantA, 'project.completion', 'Final technical approval (sample)');
  });

  test('a project with a submitted need asks for approval', async ({ tenantA }) => {
    const created = await tenantA.post('/v1/projects', {
      body: {
        title: 'بهسازی راه روستایی',
        operationType: 'road',
        scopeOfWork: 'Resurfacing of the main village road',
        locationDescription: 'Main road, north entrance',
        estimatedCostMinor: '5000000000',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = created.body as ProjectBody;
    projectId = body.id;
    expect(body.status).toBe('DRAFT');

    const need = await tenantA.post(`/v1/projects/${projectId}/needs`, {
      body: { title: 'Gravel', description: 'Base course for two kilometres' },
    });
    expect(need.status, JSON.stringify(need.body)).toBe(201);
    const submitted = await tenantA.post(
      `/v1/projects/${projectId}/needs/${(need.body as { id: string }).id}/submit`,
      { body: { expectedVersion: 1 } },
    );
    expect(submitted.status).toBe(200);

    const requested = await tenantA.post(`/v1/projects/${projectId}/approvals`, {
      body: { expectedVersion: body.version },
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect((requested.body as ProjectBody).status).toBe('PENDING_APPROVAL');

    const step = await pendingStep(tenantA, projectId, 'project.execution');
    expect(step).toMatchObject({
      round: 1,
      stepOrder: 1,
      authorityOrganizationId: ORG.platform,
      authorityRole: 'UNION_ADMIN',
    });
  });

  test('nobody but the named authority decides', async ({
    tenantA,
    tenantB,
    systemAdmin,
    auditor,
  }) => {
    const step = await pendingStep(tenantA, projectId, 'project.execution');
    const grant = { body: { expectedVersion: step.version, decision: 'GRANT' } };

    // The project's own administrator sees the step and is told it may not decide.
    const own = await tenantA.post(`/v1/approvals/${step.id}/decision`, grant);
    expect(own.status).toBe(403);
    expect(errorCode(own.body)).toBe('FORBIDDEN');

    // SYSTEM_ADMIN of the authority's organization, without the named role.
    const platform = await systemAdmin.post(`/v1/approvals/${step.id}/decision`, grant);
    expect(platform.status).toBe(403);

    // Another tenant learns nothing — not even that the step exists.
    expect((await tenantB.get(`/v1/approvals/${step.id}`)).status).toBe(404);
    expect((await tenantB.post(`/v1/approvals/${step.id}/decision`, grant)).status).toBe(404);
    expect((await tenantB.get(`/v1/projects/${projectId}`)).status).toBe(404);

    // Oversight reaches nothing here.
    expect((await auditor.get('/v1/approvals')).status).toBe(403);
    expect((await auditor.get(`/v1/projects/${projectId}`)).status).toBe(403);

    // Nothing above changed the step.
    expect(await pendingStep(tenantA, projectId, 'project.execution')).toMatchObject({
      id: step.id,
      version: step.version,
    });
  });

  test('the authority finds the step in its inbox and grants it', async ({
    tenantA,
    platformAdmin,
  }) => {
    const step = await pendingStep(tenantA, projectId, 'project.execution');

    const inbox = await platformAdmin.get('/v1/approvals?status=PENDING&limit=100');
    expect(inbox.status).toBe(200);
    expect((inbox.body as { items: ApprovalBody[] }).items.map((item) => item.id)).toContain(
      step.id,
    );

    const granted = await platformAdmin.post(`/v1/approvals/${step.id}/decision`, {
      body: { expectedVersion: step.version, decision: 'GRANT', decisionNumber: 'E2E-1' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    // The approval names its project at the top level; `project` is the brief
    // the authority decides on (title, estimate, status).
    expect(granted.body).toMatchObject({
      status: 'GRANTED',
      projectId,
      project: { status: 'APPROVED' },
    });
  });

  test('the approved project starts and reports full progress', async ({ tenantA }) => {
    const approved = await project(tenantA, projectId);
    const started = await tenantA.post(`/v1/projects/${projectId}/start`, {
      body: { expectedVersion: approved.version },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((started.body as ProjectBody).status).toBe('IN_PROGRESS');

    const draft = await tenantA.post(`/v1/projects/${projectId}/progress`, {
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

    const submitted = await tenantA.post(`/v1/projects/${projectId}/progress/${report.id}/submit`, {
      body: { expectedVersion: report.version },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED', progressBasisPoints: 10_000 });
  });

  test('completion waits for the final technical approval, then completes', async ({
    tenantA,
    platformAdmin,
  }) => {
    const running = await project(tenantA, projectId);
    const asked = await tenantA.post(`/v1/projects/${projectId}/complete`, {
      body: { expectedVersion: running.version },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    // A final approval is configured, so completing only opens its round.
    expect((asked.body as ProjectBody).status).toBe('IN_PROGRESS');

    const step = await pendingStep(tenantA, projectId, 'project.completion');
    expect(step.round).toBe(2);

    const correlationId = `e2e-con-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;
    const granted = await platformAdmin.post(`/v1/approvals/${step.id}/decision`, {
      correlationId,
      body: { expectedVersion: step.version, decision: 'GRANT' },
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({ project: { status: 'COMPLETED' } });
    expect((await project(tenantA, projectId)).status).toBe('COMPLETED');

    // The decision reached Kafka through the outbox, under the project's key
    // and tenant, carrying the correlation id of the HTTP call.
    const events = await tap.awaitCorrelated(correlationId, [
      'APPROVAL_GRANTED',
      'PROJECT_COMPLETED',
    ]);
    for (const event of events) {
      expect(event.correlationId).toBe(correlationId);
      expect(event.envelopeCorrelationId).toBe(correlationId);
      expect(event.tenantId).toBe(ORG.a);
      expect(event.key).toBe(projectId);
    }
    const completed = events.find((event) => event.eventName === 'PROJECT_COMPLETED');
    expect(completed!.payload).toMatchObject({ projectId, organizationId: ORG.a });
  });
});
