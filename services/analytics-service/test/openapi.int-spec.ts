import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildAnalyticsOpenApiDocument, formatDocument } from '../src/openapi/document';
import { actor, startApi, type ApiHarness } from './api-helpers';
import { PROBE_TRACEPARENT, httpErrorBodyProblems } from '@rasta/nest-common';
import request from 'supertest';
import { ulid } from 'ulid';

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

  it('accepts the error bodies the application really sends over HTTP, with and without a trace (audit 10-26 F3)', async () => {
    const problems: string[] = [];
    for (const traced of [true, false]) {
      const headers: Record<string, string> = traced ? { traceparent: PROBE_TRACEPARENT } : {};
      const path = '/v1/dashboards/fleet';
      const token = actor(`ORG-ENVELOPE-${ulid().slice(-8)}`, ['FLEET_MANAGER']);
      const answers = [
        {
          method: 'GET',
          url: path,
          response: await request(api.app.getHttpServer()).get(path).set(headers),
        },
        {
          method: 'GET',
          url: `${path}?from=not-a-date`,
          response: await request(api.app.getHttpServer())
            .get(path)
            .query({ from: 'not-a-date' })
            .set(headers)
            .set('authorization', `Bearer ${token}`),
        },
      ];
      expect(answers.map(({ response }) => response.status)).toEqual([401, 400]);
      expect(answers[1]!.response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(answers[1]!.response.body.details.length).toBeGreaterThan(0);
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
