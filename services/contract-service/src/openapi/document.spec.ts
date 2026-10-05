import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  RESPONSE_BODIES,
  buildContractOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/contract-service.openapi.json` is checked in so an API change shows in a PR's
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
    'contract-service.openapi.json',
  );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildContractOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes the two read endpoints of CON-003 PR 1, each closed, and no route that writes', () => {
    const document = buildContractOpenApiDocument(app);
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ key: `${method.toUpperCase()} ${path}`, operation })),
    );

    expect(operations.map((o) => o.key).sort()).toEqual(Object.keys(RESPONSE_BODIES).sort());
    expect(operations.map((o) => o.key).sort()).toEqual([
      'GET /v1/contracts',
      'GET /v1/contracts/{id}',
    ]);
    for (const { operation } of operations) {
      expect(operation.security).toEqual([{ bearer: [] }]);
      expect(operation.responses['200']).toBeDefined();
      expect(operation.responses['201']).toBeUndefined();
    }
  });

  it('documents 400 only on the list, which has a query, and 404 only on the read by id', () => {
    const document = buildContractOpenApiDocument(app);
    const list = document.paths?.['/v1/contracts']?.get as { responses: Record<string, unknown> };
    const read = document.paths?.['/v1/contracts/{id}']?.get as {
      responses: Record<string, unknown>;
    };
    expect(list.responses['400']).toBeDefined();
    expect(list.responses['404']).toBeUndefined();
    expect(read.responses['400']).toBeUndefined();
    expect(read.responses['404']).toBeDefined();
  });

  it('sends the amount as a string and shows a party nothing of who awarded', () => {
    const document = buildContractOpenApiDocument(app);
    const view = document.paths?.['/v1/contracts/{id}']?.get as unknown as {
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };
    const schema = view.responses['200']?.content['application/json']?.schema as {
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties.amountMinor?.type).toBe('string');
    for (const hidden of ['awardedBy', 'matrixDigest', 'createdBy']) {
      expect(schema.properties).not.toHaveProperty(hidden);
    }
  });

  it('keeps the health probes out of the contract', () => {
    const document = buildContractOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/health'))).toBe(
      false,
    );
  });
});
