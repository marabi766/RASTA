import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildInventoryOpenApiDocument, formatDocument } from '../src/openapi/document';
import { key, orgAdmin, seedStock, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId } from './helpers';
import { PROBE_TRACEPARENT, httpErrorBodyProblems } from '@rasta/nest-common';
import request from 'supertest';

/**
 * The published contract, checked against the service that answers it (the arrangement
 * construction-service and contract-service made):
 *
 *   **The committed document is the real application's.** Built from the booted `AppModule` and
 *   required to equal `docs/api/inventory-service.openapi.json` byte for byte; the unit spec
 *   proves the generator's module produces the same file.
 *
 *   **It describes exactly the routes the application serves**, read from the Express router —
 *   in the order the router meets them, so `stock/reservations` and `stock/movements` are never
 *   read as a stock item id. The refusals it documents are provoked by `api.int-spec.ts`.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    document = buildInventoryOpenApiDocument(api.app);
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  const runtimeRoutes = () => {
    const server = api.app.getHttpAdapter().getInstance() as {
      router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    return ((server.router ?? server._router)?.stack ?? [])
      .filter((layer) => layer.route && layer.route.path.startsWith('/v1/'))
      .flatMap((layer) =>
        Object.entries(layer.route!.methods)
          .filter(([, enabled]) => enabled)
          .map(
            ([method]) => `${method.toUpperCase()} ${layer.route!.path.replace(/:(\w+)/g, '{$1}')}`,
          ),
      );
  };

  it('is exactly the committed document', () => {
    const committedPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'api',
      'inventory-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the business routes the application answers on', () => {
    const documented = Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(documented).toEqual([...runtimeRoutes()].sort());
  });

  it('meets the static stock routes before the stock item id', () => {
    const routes = runtimeRoutes();
    const byId = routes.indexOf('GET /v1/stock/{id}');
    for (const route of ['GET /v1/stock/reservations', 'GET /v1/stock/movements']) {
      expect([route, routes.indexOf(route) < byId]).toEqual([route, true]);
    }
  });

  it('accepts the error bodies the application really sends over HTTP, with and without a trace (audit 10-26 F3)', async () => {
    const owner = newOrganizationId();
    organizations.push(owner);
    const stock = await seedStock(api, owner, 5);
    const problems: string[] = [];
    for (const traced of [true, false]) {
      const headers: Record<string, string> = traced ? { traceparent: PROBE_TRACEPARENT } : {};
      const path = '/v1/warehouses';
      const answers = [
        {
          method: 'GET',
          url: path,
          response: await request(api.app.getHttpServer()).get(path).set(headers),
        },
        {
          method: 'GET',
          url: `${path}?limit=zzz`,
          response: await request(api.app.getHttpServer())
            .get(`${path}?limit=zzz`)
            .set(headers)
            .set('authorization', `Bearer ${orgAdmin(owner)}`),
        },
        {
          method: 'POST',
          url: '/v1/stock/reservations',
          response: await request(api.app.getHttpServer())
            .post('/v1/stock/reservations')
            .set(headers)
            .set('authorization', `Bearer ${orgAdmin(owner)}`)
            .set('idempotency-key', key())
            .send({ lines: [{ stockItemId: stock.stockItemId, quantity: 99 }] }),
        },
      ];
      expect(answers.map(({ response }) => response.status)).toEqual([401, 400, 422]);
      expect(answers[1]!.response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(answers[1]!.response.body.details.length).toBeGreaterThan(0);
      expect(answers[2]!.response.body).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        details: [{ path: 'reservation', code: 'INSUFFICIENT_AVAILABLE_STOCK' }],
      });
      for (const { method, url, response } of answers) {
        problems.push(
          ...httpErrorBodyProblems(document, {
            method,
            url,
            status: response.status,
            body: response.body,
            traced,
          }),
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
