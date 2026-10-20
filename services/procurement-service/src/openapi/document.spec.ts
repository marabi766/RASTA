import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  RESPONSE_BODIES,
  buildProcurementOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/procurement-service.openapi.json` is checked in so an API change shows in a PR's
 * diff; this spec turns "remember to regenerate" into a failing test. That the document
 * describes the **real** application is `test/openapi.int-spec.ts`.
 */
describe('the committed OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const docs = join(__dirname, '..', '..', '..', '..', 'docs', 'api');
  const committedPath = join(docs, 'procurement-service.openapi.json');

  type Operation = {
    security?: unknown;
    parameters?: { name: string; in: string; required?: boolean }[];
    responses: Record<string, unknown>;
  };
  const operations = () =>
    Object.entries(buildProcurementOpenApiDocument(app).paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, Operation>).map(([method, operation]) => ({
        key: `${method.toUpperCase()} ${path}`,
        operation,
      })),
    );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildProcurementOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes exactly the operations the planned contract gives ADR-070 plan PRs 1 to 3, each closed', () => {
    const planned = JSON.parse(
      readFileSync(join(docs, 'procurement-service.planned.openapi.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, { 'x-step'?: string }>> };
    const built = Object.entries(planned.paths)
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([, operation]) => ['PR 1', 'PR 2', 'PR 3'].includes(operation['x-step'] ?? ''))
          .map(([method]) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

    const published = operations();
    expect(published.map((o) => o.key).sort()).toEqual(built);
    expect(published.map((o) => o.key).sort()).toEqual(Object.keys(RESPONSE_BODIES).sort());
    for (const { key, operation } of published) {
      expect({ key, security: operation.security }).toEqual({ key, security: [{ bearer: [] }] });
      const created = key === 'POST /v1/demand-requests';
      expect(operation.responses['200'] !== undefined).toBe(!created);
      expect(operation.responses['201'] !== undefined).toBe(created);
    }
  });

  it('requires an Idempotency-Key on both commands and on nothing else', () => {
    for (const { key, operation } of operations()) {
      const header = (operation.parameters ?? []).filter((p) => p.in === 'header');
      expect({ key, header }).toEqual({
        key,
        header: key.startsWith('POST ')
          ? [expect.objectContaining({ name: 'Idempotency-Key', required: true })]
          : [],
      });
    }
  });

  it('documents 400 on the lists and commands, 404 on every route by id, 409 and 422 only on the commands', () => {
    const byKey = new Map(operations().map((o) => [o.key, o.operation.responses]));
    const list = byKey.get('GET /v1/demand-requests')!;
    const read = byKey.get('GET /v1/aggregations/{id}')!;
    expect(list['400']).toBeDefined();
    expect(list['404']).toBeUndefined();
    expect(read['400']).toBeUndefined();
    expect(read['404']).toBeDefined();
    for (const reader of [list, read]) {
      expect(reader['409']).toBeUndefined();
      expect(reader['422']).toBeUndefined();
    }
    for (const command of [
      'POST /v1/demand-requests/{id}/withdraw',
      'POST /v1/aggregations/{id}/cancel',
    ]) {
      const responses = byKey.get(command)!;
      for (const status of ['200', '400', '401', '403', '404', '409', '422']) {
        expect({ command, status, documented: responses[status] !== undefined }).toEqual({
          command,
          status,
          documented: true,
        });
      }
    }
    const submit = byKey.get('POST /v1/demand-requests')!;
    expect(submit['404']).toBeUndefined();
    expect(submit['409']).toBeDefined();
  });

  it.each([
    [
      'POST /v1/demand-requests',
      'submission',
      ['AGGREGATION_QUANTITY_LIMIT_EXCEEDED', 'AGGREGATION_DEMAND_LIMIT_REACHED'],
    ],
    [
      'POST /v1/demand-requests/{id}/withdraw',
      'withdrawal',
      ['DEMAND_NOT_SUBMITTED', 'AGGREGATION_WINDOW_ENDED'],
    ],
    ['POST /v1/aggregations/{id}/cancel', 'cancellation', ['AGGREGATION_NOT_READY']],
  ])('types the 422 of %s with its closed reasons', (key, area, codes) => {
    const responses = new Map(operations().map((o) => [o.key, o.operation.responses])).get(key)!;
    const schema = (
      responses['422'] as {
        content: Record<
          string,
          {
            schema: {
              properties: {
                details: {
                  items: { properties: { path: { const: string }; code: { enum: string[] } } };
                };
              };
            };
          }
        >;
      }
    ).content['application/json']!.schema;
    expect(schema.properties.details.items.properties.path.const).toBe(area);
    expect(schema.properties.details.items.properties.code.enum).toEqual(codes);
  });

  it('carries the setting snapshot and the total as a bounded integer on an aggregation, and no amount field anywhere', () => {
    const text = readFileSync(committedPath, 'utf8');
    // No property, parameter or schema named for money: the words may appear in prose only.
    expect(text).not.toMatch(/"\w*(amount|price|Amount|Price)\w*"\s*:/);
    const document = buildProcurementOpenApiDocument(app) as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              {
                content: Record<
                  string,
                  { schema: { properties: Record<string, { type?: string; required?: string[] }> } }
                >;
              }
            >;
          }
        >
      >;
    };
    const aggregation =
      document.paths['/v1/aggregations/{id}']!.get!.responses['200']!.content['application/json']!
        .schema.properties;
    expect(aggregation.totalQuantity).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 2147483647,
    });
    expect(aggregation.setting?.required).toEqual([
      'windowHours',
      'minQuantity',
      'shortfallPolicy',
      'settingVersion',
    ]);
  });

  it('keeps the health probes out of the contract', () => {
    const document = buildProcurementOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/health'))).toBe(
      false,
    );
  });
});
