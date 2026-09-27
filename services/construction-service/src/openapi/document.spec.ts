import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  RESPONSE_BODIES,
  buildConstructionOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/construction-service.openapi.json` is checked in so an API change
 * shows in a PR's diff; this spec turns "remember to regenerate" into a failing
 * test. That the document describes the **real** application is
 * `test/openapi.int-spec.ts`.
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
    'construction-service.openapi.json',
  );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', () => {
    const generated = formatDocument(buildConstructionOpenApiDocument(app), committedPath);
    expect(readFileSync(committedPath, 'utf8')).toBe(generated);
  });

  it('publishes the ten endpoints of CON-001 PR 1, each closed, each with its real success status', () => {
    const document = buildConstructionOpenApiDocument(app);
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ key: `${method.toUpperCase()} ${path}`, operation })),
    );

    expect(operations.map((o) => o.key).sort()).toEqual(Object.keys(RESPONSE_BODIES).sort());
    for (const { key, operation } of operations) {
      expect(operation.security).toEqual([{ bearer: [] }]);
      const success = RESPONSE_BODIES[key]?.status;
      expect(operation.responses[success ?? 'missing']).toBeDefined();
      const other = success === '201' ? '200' : '201';
      expect(operation.responses[other]).toBeUndefined();
    }
  });

  it('documents 409 and 422 only where a command can produce them', () => {
    const document = buildConstructionOpenApiDocument(app);
    const get = document.paths?.['/v1/projects/{id}']?.get as {
      responses: Record<string, unknown>;
    };
    const cancel = document.paths?.['/v1/projects/{id}/cancel']?.post as {
      responses: Record<string, unknown>;
    };
    expect(get.responses['409']).toBeUndefined();
    expect(get.responses['422']).toBeUndefined();
    expect(cancel.responses['409']).toBeDefined();
    expect(cancel.responses['422']).toBeDefined();
  });

  it('describes the Idempotency-Key header as optional, on the two create endpoints only', () => {
    const document = buildConstructionOpenApiDocument(app);
    const headerOf = (path: string, method: string) =>
      (
        (
          document.paths?.[path] as Record<
            string,
            { parameters?: { name: string; in: string; required?: boolean }[] }
          >
        )[method]?.parameters ?? []
      ).find((parameter) => parameter.in === 'header');

    expect(headerOf('/v1/projects', 'post')).toMatchObject({
      name: 'Idempotency-Key',
      required: false,
    });
    expect(headerOf('/v1/projects/{id}/needs', 'post')).toMatchObject({ required: false });
    expect(headerOf('/v1/projects/{id}', 'patch')).toBeUndefined();
  });

  it('keeps the health probes out of the contract', () => {
    const document = buildConstructionOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/health'))).toBe(
      false,
    );
  });
});
