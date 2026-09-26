import request from 'supertest';
import {
  actor,
  apiTenant,
  auditorActor,
  bearer,
  internalToken,
  multiMemberActor,
  orgAdmin,
  startApi,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import { PROJECT, SQUARE, cleanup } from './helpers';

/**
 * Every public endpoint through the real application (`docs/14` § 14.5): the
 * guards, the exception filter, the context middleware and URI versioning come
 * from the real graph, so this is where a refusal is proven to carry the right
 * status — a cross-tenant read a 404, a missing role a 403, a stale version a
 * 409, a lifecycle refusal a 422.
 */

describe('construction HTTP API', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  const tenant = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };

  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  async function createProject(
    org: string,
    body: object = PROJECT,
  ): Promise<{ id: string; version: number }> {
    const response = await http()
      .post('/v1/projects')
      .set('authorization', `Bearer ${orgAdmin(org)}`)
      .send(body)
      .expect(201);
    return response.body as { id: string; version: number };
  }

  describe('the project endpoints', () => {
    it('POST /v1/projects creates a DRAFT and answers 201 with the full view', async () => {
      const org = tenant('CREATE');
      const response = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .send({ ...PROJECT, area: SQUARE, estimatedCostMinor: '1000' })
        .expect(201);

      expect(response.body).toMatchObject({
        organizationId: org,
        status: 'DRAFT',
        version: 1,
        area: SQUARE,
        estimatedCostMinor: '1000',
      });
      expect(response.headers['x-correlation-id']).toBeTruthy();
    });

    it('GET /v1/projects and GET /v1/projects/{id} answer 200', async () => {
      const org = tenant('READ');
      const project = await createProject(org);
      const token = orgAdmin(org);

      const list = await http()
        .get('/v1/projects?limit=10')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([project.id]);

      const one = await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(one.body.id).toBe(project.id);
    });

    it('PATCH answers 200, then 409 for the stale version, and 422 after cancellation', async () => {
      const org = tenant('PATCH');
      const project = await createProject(org);
      const token = orgAdmin(org);

      await http()
        .patch(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, title: 'Edited once' })
        .expect(200);

      const stale = await http()
        .patch(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, title: 'Lost update' })
        .expect(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');

      const cancelled = await http()
        .post(`/v1/projects/${project.id}/cancel`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 2, reason: 'Funding was withdrawn' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const refused = await http()
        .patch(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 3, title: 'Too late' })
        .expect(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('refuses a body that tries to set the organization or the status, with 400', async () => {
      const org = tenant('STRICT');
      for (const extra of [{ organizationId: 'ORG-OTHER' }, { status: 'APPROVED' }]) {
        const response = await http()
          .post('/v1/projects')
          .set('authorization', `Bearer ${orgAdmin(org)}`)
          .send({ ...PROJECT, ...extra })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses a self-intersecting area with 400 on the area field', async () => {
      const org = tenant('GEOM');
      const response = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .send({
          ...PROJECT,
          area: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 1],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        })
        .expect(400);
      expect(JSON.stringify(response.body)).toContain('area');
    });
  });

  describe('the need endpoints', () => {
    it('add (201), list, edit, submit and withdraw (200)', async () => {
      const org = tenant('NEEDS');
      const project = await createProject(org);
      const token = orgAdmin(org);

      const added = await http()
        .post(`/v1/projects/${project.id}/needs`)
        .set('authorization', `Bearer ${token}`)
        .send({ title: 'Gravel', description: 'Base course', quantity: '12.5', unit: 'm3' })
        .expect(201);
      const needId = added.body.id as string;

      const list = await http()
        .get(`/v1/projects/${project.id}/needs`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.items).toHaveLength(1);

      await http()
        .patch(`/v1/projects/${project.id}/needs/${needId}`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 1, quantity: '13' })
        .expect(200);
      await http()
        .post(`/v1/projects/${project.id}/needs/${needId}/submit`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 2 })
        .expect(200);
      const withdrawn = await http()
        .post(`/v1/projects/${project.id}/needs/${needId}/withdraw`)
        .set('authorization', `Bearer ${token}`)
        .send({ expectedVersion: 3, reason: 'Scope was reduced' })
        .expect(200);
      expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', quantity: '13' });
    });
  });

  describe('authorization', () => {
    it('answers 401 with no token', async () => {
      await http().get('/v1/projects').expect(401);
    });

    it('refuses a role the configuration does not grant with 403 INSUFFICIENT_ROLE', async () => {
      const org = tenant('ROLE');
      const response = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${actor(org, ['FLEET_MANAGER'])}`)
        .send(PROJECT)
        .expect(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('refuses the oversight role on every route, even reading', async () => {
      const org = tenant('AUDITOR');
      const project = await createProject(org);
      await http()
        .get('/v1/projects')
        .set('authorization', `Bearer ${auditorActor(org)}`)
        .expect(403);
      await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${auditorActor(org)}`)
        .expect(403);
    });

    it('refuses a SYSTEM_ADMIN with no selected organization, with a reason rather than a 500', async () => {
      const response = await http()
        .get('/v1/projects')
        .set('authorization', `Bearer ${systemAdminWithoutTenant()}`)
        .expect(403);
      expect(response.body.message).toMatch(/X-Organization-Id/);
    });

    it('serves a SYSTEM_ADMIN acting for an organization it belongs to, whatever its role there', async () => {
      const org = tenant('SYSADMIN');
      const project = await createProject(org);
      const token = bearer({
        sub: `sub-${org}`,
        rastaUserId: `USR-APITEST-${org.slice(-8)}`,
        organizationIds: [org],
        roles: ['SYSTEM_ADMIN'],
      });

      const selected = await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .set('x-organization-id', org)
        .expect(200);
      expect(selected.body.id).toBe(project.id);
    });

    it('refuses a service-to-service token: no endpoint grants one', async () => {
      const org = tenant('SERVICE');
      const token = await internalToken('audit-service', { organizationId: org });
      // `x-internal-token` is the header the guard routes a service call by.
      const response = await http().get('/v1/projects').set('x-internal-token', token);
      expect(response.status).toBe(403);
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('answers 404 — never 403 — for another organization’s project and its needs', async () => {
      const a = tenant('ISO-A');
      const b = tenant('ISO-B');
      const project = await createProject(a);
      const intruder = orgAdmin(b);

      const calls = [
        () => http().get(`/v1/projects/${project.id}`),
        () =>
          http().patch(`/v1/projects/${project.id}`).send({ expectedVersion: 1, title: 'Hijack' }),
        () =>
          http()
            .post(`/v1/projects/${project.id}/cancel`)
            .send({ expectedVersion: 1, reason: 'Hijack attempt' }),
        () => http().get(`/v1/projects/${project.id}/needs`),
        () =>
          http()
            .post(`/v1/projects/${project.id}/needs`)
            .send({ title: 'Inject', description: 'x' }),
      ];
      for (const call of calls) {
        const response = await call().set('authorization', `Bearer ${intruder}`);
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
      }
    });

    it('refuses X-Organization-Id naming an organization the caller does not belong to', async () => {
      const a = tenant('HDR-A');
      const b = tenant('HDR-B');
      const project = await createProject(a);
      const response = await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${orgAdmin(b)}`)
        .set('x-organization-id', a);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_MISMATCH');
    });

    it('lets a member of both organizations reach A only by acting for A', async () => {
      const a = tenant('BOTH-A');
      const b = tenant('BOTH-B');
      const project = await createProject(a);
      const token = multiMemberActor(b, [a], ['ORGANIZATION_ADMIN']);

      await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(404);
      await http()
        .get(`/v1/projects/${project.id}`)
        .set('authorization', `Bearer ${token}`)
        .set('x-organization-id', a)
        .expect(200);
    });
  });

  describe('Idempotency-Key', () => {
    it('replays the first 201 response for a retry, and refuses the key with another body (409)', async () => {
      const org = tenant('IDEM');
      const token = orgAdmin(org);

      const first = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', 'create-once')
        .send(PROJECT)
        .expect(201);
      const retry = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', 'create-once')
        .send(PROJECT)
        .expect(201);
      expect(retry.body).toEqual(first.body);

      const reused = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', 'create-once')
        .send({ ...PROJECT, title: 'Different' })
        .expect(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses an over-long key with 400', async () => {
      const org = tenant('IDEM-LONG');
      await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${orgAdmin(org)}`)
        .set('idempotency-key', 'k'.repeat(256))
        .send(PROJECT)
        .expect(400);
    });
  });

  it('never exposes a token-shaped value in a refusal', async () => {
    const response = await http()
      .get('/v1/projects')
      .set('authorization', `Bearer ${bearer({ sub: 'x', roles: [] })}`);
    expect(JSON.stringify(response.body)).not.toContain('test.');
  });
});
