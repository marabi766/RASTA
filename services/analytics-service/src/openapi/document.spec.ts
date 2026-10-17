import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  RESPONSE_BODIES,
  buildAnalyticsOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/analytics-service.openapi.json` is checked in so an API change shows in a PR's
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

  const committedPath = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'api',
    'analytics-service.openapi.json',
  );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildAnalyticsOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes the one read endpoint of RUN-001 PR 1, closed, and no route that writes', () => {
    const document = buildAnalyticsOpenApiDocument(app);
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ key: `${method.toUpperCase()} ${path}`, operation })),
    );

    expect(operations.map((o) => o.key)).toEqual(Object.keys(RESPONSE_BODIES));
    expect(operations.map((o) => o.key)).toEqual(['GET /v1/dashboards/fleet']);
    for (const { operation } of operations) {
      expect(operation.security).toEqual([{ bearer: [] }]);
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '401', '403', '500']);
    }
  });

  it('requires both ends of the window and sends every amount as a string', () => {
    const document = buildAnalyticsOpenApiDocument(app);
    const fleet = document.paths?.['/v1/dashboards/fleet']?.get as unknown as {
      parameters: { name: string; required: boolean }[];
      responses: Record<string, { content: Record<string, { schema: unknown }> }>;
    };
    expect(fleet.parameters.map((p) => [p.name, p.required])).toEqual([
      ['from', true],
      ['to', true],
    ]);
    const schema = JSON.stringify(fleet.responses['200']?.content['application/json']?.schema);
    expect(schema).toContain('"amountMinor":{"type":"string"');
  });

  it('keeps the health probes and the metrics target out of the contract', () => {
    const document = buildAnalyticsOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => /^\/(health|metrics)/.test(path))).toBe(
      false,
    );
  });
});
