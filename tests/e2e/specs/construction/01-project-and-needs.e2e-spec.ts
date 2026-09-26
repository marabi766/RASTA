import { test, expect, errorCode, idempotencyKey } from '../../src/api';
import { ORG } from '../../src/env';
import { waitFor } from '../../src/events';

/**
 * CON-001 PR 1 through the whole stack: a real Keycloak token, api-gateway,
 * construction-service, PostgreSQL, Kafka and audit-service. Nothing stubbed.
 *
 * `tenantA` (`ORG-DEH-0001`, `ORGANIZATION_ADMIN` — the default project role)
 * owns the project; `tenantB` is the other tenant and must learn nothing;
 * `systemAdmin` reads the audit evidence; `auditor` reaches nothing.
 *
 * What is proven, in order: the routes are closed without a token; creation is
 * idempotent under one key and refuses the key with another body; a project
 * and its need walk their lifecycle; a stale version is a 409 and changes
 * nothing; another tenant gets 404 for every route; and the creation arrives
 * in audit-service as a queryable record under the request's correlation id.
 */

interface ProjectBody {
  id: string;
  status: string;
  version: number;
  title: string;
  statusReason: string | null;
  needsSummary: { draft: number; submitted: number; withdrawn: number };
}

interface NeedBody {
  id: string;
  status: string;
  version: number;
}

const PROJECT = {
  title: 'بهسازی راه روستایی',
  operationType: 'road',
  scopeOfWork: 'Resurfacing of the main village road',
  locationDescription: 'Main road, north entrance',
  estimatedCostMinor: '5000000000',
};

/** A window wide enough to hold this run and inside the audit API's 90-day ceiling. */
function recentWindow(): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

test.describe.serial('construction projects and needs (CON-001 PR 1)', () => {
  let projectId: string;
  let createdCorrelationId: string;

  test('the construction routes are closed without a token', async ({ anonymous }) => {
    for (const path of ['/v1/projects', '/v1/projects/PRJ_ANY', '/v1/projects/PRJ_ANY/needs']) {
      expect((await anonymous.get(path)).status).toBe(401);
    }
  });

  test('creation is idempotent under one key, and refuses that key with another body', async ({
    tenantA,
  }) => {
    const key = idempotencyKey('con-create');
    createdCorrelationId = `e2e-con-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;

    const first = await tenantA.post('/v1/projects', {
      idempotencyKey: key,
      correlationId: createdCorrelationId,
      body: PROJECT,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const created = first.body as ProjectBody;
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, title: PROJECT.title });
    projectId = created.id;

    // The retry replays the stored response and creates nothing.
    const retry = await tenantA.post('/v1/projects', { idempotencyKey: key, body: PROJECT });
    expect(retry.status).toBe(201);
    expect((retry.body as ProjectBody).id).toBe(projectId);

    const reused = await tenantA.post('/v1/projects', {
      idempotencyKey: key,
      body: { ...PROJECT, title: 'Another project' },
    });
    expect(reused.status).toBe(409);
    expect(errorCode(reused.body)).toBe('IDEMPOTENCY_KEY_REUSED');

    const list = await tenantA.get('/v1/projects?limit=100');
    expect(list.status).toBe(200);
    const ids = (list.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids.filter((id) => id === projectId)).toHaveLength(1);
  });

  test('a project and its need walk their lifecycle', async ({ tenantA }) => {
    const need = await tenantA.post(`/v1/projects/${projectId}/needs`, {
      body: { title: 'Gravel', description: 'Base course for two kilometres' },
    });
    expect(need.status, JSON.stringify(need.body)).toBe(201);
    const drafted = need.body as NeedBody;
    expect(drafted).toMatchObject({ status: 'DRAFT', version: 1 });

    const edited = await tenantA.patch(`/v1/projects/${projectId}/needs/${drafted.id}`, {
      body: { expectedVersion: 1, quantity: '120', unit: 'm3' },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const submitted = await tenantA.post(`/v1/projects/${projectId}/needs/${drafted.id}/submit`, {
      body: { expectedVersion: 2 },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED', version: 3 });

    // A submitted need is immutable: correcting it means withdraw and add anew.
    const frozen = await tenantA.patch(`/v1/projects/${projectId}/needs/${drafted.id}`, {
      body: { expectedVersion: 3, unit: 'tonne' },
    });
    expect(frozen.status).toBe(422);
    const withdrawn = await tenantA.post(`/v1/projects/${projectId}/needs/${drafted.id}/withdraw`, {
      body: { expectedVersion: 3, reason: 'Quantity was wrong' },
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', version: 4 });

    const renamed = await tenantA.patch(`/v1/projects/${projectId}`, {
      body: { expectedVersion: 1, title: 'بهسازی و آسفالت راه روستایی' },
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({
      version: 2,
      needsSummary: { draft: 0, submitted: 0, withdrawn: 1 },
    });
  });

  test('a stale version is a 409 and changes nothing', async ({ tenantA }) => {
    const stale = await tenantA.patch(`/v1/projects/${projectId}`, {
      body: { expectedVersion: 1, title: 'A lost update' },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe('OPTIMISTIC_LOCK_FAILED');

    const current = await tenantA.get(`/v1/projects/${projectId}`);
    expect(current.body).toMatchObject({ version: 2, title: 'بهسازی و آسفالت راه روستایی' });
  });

  test('another tenant gets 404 on every route, and the oversight role reaches nothing', async ({
    tenantA,
    tenantB,
    auditor,
  }) => {
    const probes = [
      () => tenantB.get(`/v1/projects/${projectId}`),
      () => tenantB.get(`/v1/projects/${projectId}/needs`),
      () =>
        tenantB.patch(`/v1/projects/${projectId}`, { body: { expectedVersion: 2, title: 'x' } }),
      () =>
        tenantB.post(`/v1/projects/${projectId}/needs`, { body: { title: 'x', description: 'y' } }),
      () =>
        tenantB.post(`/v1/projects/${projectId}/cancel`, {
          body: { expectedVersion: 2, reason: 'Not yours' },
        }),
    ];
    for (const probe of probes) {
      const response = await probe();
      // 404, not 403: a refusal by name would confirm the project exists.
      expect(response.status).toBe(404);
    }
    const list = await tenantB.get('/v1/projects?limit=100');
    expect((list.body as { items: { id: string }[] }).items.map((item) => item.id)).not.toContain(
      projectId,
    );
    expect((await auditor.get(`/v1/projects/${projectId}`)).status).toBe(403);

    // Nothing above changed the project.
    expect((await tenantA.get(`/v1/projects/${projectId}`)).body).toMatchObject({
      version: 2,
      status: 'DRAFT',
    });
  });

  test('cancellation is terminal and keeps its reason in the service', async ({ tenantA }) => {
    const cancelled = await tenantA.post(`/v1/projects/${projectId}/cancel`, {
      body: { expectedVersion: 2, reason: 'Funding was withdrawn' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      statusReason: 'Funding was withdrawn',
      version: 3,
    });
    const again = await tenantA.post(`/v1/projects/${projectId}/cancel`, {
      body: { expectedVersion: 3, reason: 'Twice' },
    });
    expect(again.status).toBe(422);
  });

  test('the creation arrives in audit-service as a queryable record', async ({ systemAdmin }) => {
    interface AuditItem {
      organizationId: string | null;
      correlationId: string;
      sourceTopic: string;
      sourceEventName: string;
      outcome: string;
    }
    let record: AuditItem | undefined;
    await waitFor(
      `an audit record for correlation ${createdCorrelationId}`,
      async () => {
        const parameters = new URLSearchParams({
          ...recentWindow(),
          correlationId: createdCorrelationId,
          limit: '50',
        }).toString();
        const response = await systemAdmin.get(`/v1/audit-events?${parameters}`);
        if (response.status !== 200) return false;
        record = (response.body as { items: AuditItem[] }).items.find(
          (item) => item.sourceEventName === 'PROJECT_CREATED',
        );
        return record !== undefined;
      },
      120_000,
    );

    expect(record).toMatchObject({
      organizationId: ORG.a,
      correlationId: createdCorrelationId,
      sourceTopic: 'rasta.construction.v1',
      sourceEventName: 'PROJECT_CREATED',
      outcome: 'SUCCESS',
    });
  });
});
