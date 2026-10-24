import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildAnalyticsOpenApiDocument, formatDocument } from '../src/openapi/document';
import { startApi, type ApiHarness } from './api-helpers';

/**
 * The published contract, checked against the service that answers it (the arrangement
 * construction-service and contract-service made): the committed document is the one the
 * booted `AppModule` produces, byte for byte, and it describes exactly the routes the Express
 * router serves. The statuses it documents are provoked by `api.int-spec.ts`.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;

  beforeAll(async () => {
    api = await startApi();
    document = buildAnalyticsOpenApiDocument(api.app);
  });

  afterAll(async () => {
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
          .map(([method]) => `${method.toUpperCase()} ${layer.route!.path}`),
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
      'analytics-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the business routes the application answers on', () => {
    const documented = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual([...runtimeRoutes()].sort());
    expect(documented).toEqual(['GET /v1/dashboards/fleet', 'GET /v1/kpis']);
  });
});
