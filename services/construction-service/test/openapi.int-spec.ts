import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildConstructionOpenApiDocument, formatDocument } from '../src/openapi/document';
import { actor, apiTenant, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { PROJECT, cleanup } from './helpers';

/**
 * The published contract, checked against the service that answers it.
 *
 *   **The committed document is the real application's.** Built from the
 *   booted `AppModule` and required to equal
 *   `docs/api/construction-service.openapi.json` byte for byte; the unit spec
 *   proves the generator's module produces the same file.
 *
 *   **It describes exactly the routes the application serves.** Read from the
 *   Express router, not from a list kept beside it.
 *
 *   **Every documented error status is reachable** by a real request (500
 *   aside), so no documented status is a lie a client must branch for.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    document = buildConstructionOpenApiDocument(api.app);
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  it('is exactly the committed document', () => {
    const committedPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'api',
      'construction-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the business routes the application answers on', () => {
    const server = api.app.getHttpAdapter().getInstance() as {
      router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    const runtime = ((server.router ?? server._router)?.stack ?? [])
      .filter((layer) => layer.route && layer.route.path.startsWith('/v1/'))
      .flatMap((layer) =>
        Object.entries(layer.route!.methods)
          .filter(([, enabled]) => enabled)
          .map(
            ([method]) => `${method.toUpperCase()} ${layer.route!.path.replace(/:(\w+)/g, '{$1}')}`,
          ),
      )
      .sort();

    const documented = Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

    expect(documented).toEqual(runtime);
  });

  it('can produce every documented status except 500', async () => {
    const documented = new Set<string>();
    for (const item of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(item as Record<string, { responses: object }>)) {
        for (const status of Object.keys(operation.responses)) documented.add(status);
      }
    }

    const org = apiTenant('OAS');
    const other = apiTenant('OAS-OTHER');
    organizations.push(org, other);
    const token = orgAdmin(org);
    const http = () => request(api.app.getHttpServer());
    const reached = new Set<string>();

    const created = await http()
      .post('/v1/projects')
      .set('authorization', `Bearer ${token}`)
      .send(PROJECT);
    reached.add(String(created.status)); // 201
    const id = created.body.id as string;
    reached.add(
      String(
        (await http().get(`/v1/projects/${id}`).set('authorization', `Bearer ${token}`)).status,
      ),
    ); // 200
    reached.add(
      String(
        (await http().get('/v1/projects?limit=999').set('authorization', `Bearer ${token}`)).status,
      ),
    ); // 400
    reached.add(String((await http().get('/v1/projects')).status)); // 401
    reached.add(
      String(
        (
          await http()
            .get('/v1/projects')
            .set('authorization', `Bearer ${actor(org, ['DRIVER'])}`)
        ).status,
      ),
    ); // 403
    reached.add(
      String(
        (
          await http()
            .get(`/v1/projects/${id}`)
            .set('authorization', `Bearer ${orgAdmin(other)}`)
        ).status,
      ),
    ); // 404
    reached.add(
      String(
        (
          await http()
            .patch(`/v1/projects/${id}`)
            .set('authorization', `Bearer ${token}`)
            .send({ expectedVersion: 9, title: 'Stale' })
        ).status,
      ),
    ); // 409
    await http()
      .post(`/v1/projects/${id}/cancel`)
      .set('authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1, reason: 'Funding was withdrawn' });
    reached.add(
      String(
        (
          await http()
            .post(`/v1/projects/${id}/needs`)
            .set('authorization', `Bearer ${token}`)
            .send({ title: 'Late', description: 'Too late' })
        ).status,
      ),
    ); // 422

    documented.delete('500');
    expect([...reached].sort()).toEqual([...documented].sort());
  });
});
