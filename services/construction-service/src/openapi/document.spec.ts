import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  REFUSAL_REASONS,
  RESPONSE_BODIES,
  buildConstructionOpenApiDocument,
  buildDocumentationApp,
  formatDocument,
  refusalStatusOf,
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

  it('declares an optional integer Retry-After on an idempotent create’s 409, and only there', () => {
    // docs/06 § 6.8: the in-flight CONFLICT carries it. A versioned command has
    // no Idempotency-Key, so its 409 (a stale version) must not promise one.
    const document = buildConstructionOpenApiDocument(app);
    const conflictOf = (path: string) =>
      (
        (document.paths?.[path] as Record<string, never>).post as unknown as {
          responses: Record<string, { headers?: Record<string, unknown> }>;
        }
      ).responses['409'];

    for (const path of ['/v1/projects', '/v1/projects/{id}/needs', '/v1/approval-policies']) {
      expect(conflictOf(path)?.headers).toEqual({
        'Retry-After': expect.objectContaining({
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 3600 },
        }),
      });
    }
    expect(conflictOf('/v1/projects/{id}/cancel')).toBeDefined();
    expect(conflictOf('/v1/projects/{id}/cancel')?.headers).toBeUndefined();
  });

  describe('closed refusal reasons in details[].code', () => {
    type Detail = {
      anyOf?: Detail[];
      properties?: { path: { const: string }; code: { enum: string[] } };
    };
    const detailsOf = (key: string, status: string): Detail | undefined => {
      const [method, path] = key.split(' ') as [string, string];
      const document = buildConstructionOpenApiDocument(app);
      const operation = (document.paths?.[path] as Record<string, unknown> | undefined)?.[
        method.toLowerCase()
      ] as { responses: Record<string, unknown> } | undefined;
      const response = operation?.responses[status] as
        | { content: { 'application/json': { schema: { properties?: Record<string, unknown> } } } }
        | undefined;
      const details = response?.content['application/json'].schema.properties?.details as
        { items: Detail } | undefined;
      return details?.items;
    };
    const enumsOf = (detail: Detail | undefined): Record<string, string[]> =>
      Object.fromEntries(
        (detail?.anyOf ?? (detail ? [detail] : [])).map((entry) => [
          entry.properties!.path.const,
          entry.properties!.code.enum,
        ]),
      );

    it('every listed route is a route of the document, and every reason is documented under its status', () => {
      for (const [key, byArea] of Object.entries(REFUSAL_REASONS)) {
        expect(Object.keys(RESPONSE_BODIES)).toContain(key);
        for (const [area, reasons] of Object.entries(byArea)) {
          for (const reason of reasons as readonly string[]) {
            expect({
              key,
              area,
              reason,
              listed: enumsOf(detailsOf(key, refusalStatusOf(reason)))[area],
            }).toEqual({
              key,
              area,
              reason,
              listed: expect.arrayContaining([reason]),
            });
          }
        }
      }
    });

    it('splits a route’s reasons by status: 403 names who may not act, 409 a state that moved, 422 a rule', () => {
      expect(enumsOf(detailsOf('POST /v1/tenders/{id}/award', '403'))).toEqual({
        award: ['CONFLICT_OF_INTEREST', 'AWARDER_IS_EVALUATOR'],
      });
      expect(enumsOf(detailsOf('POST /v1/tenders/{id}/award', '409'))).toEqual({
        award: ['ALREADY_AWARDED'],
        approval: ['APPROVAL_STALE'],
      });
      // The award opens the winning bid: a receipt-integrity failure is the opening area's.
      expect(enumsOf(detailsOf('POST /v1/tenders/{id}/award', '422')).opening).toEqual([
        'INTEGRITY',
      ]);
      expect(enumsOf(detailsOf('POST /v1/tenders/{id}/open-bids/proposal', '422'))).toEqual({
        opening: ['NOT_CLOSED'],
      });
    });

    it('a route without a closed reason keeps the plain error body', () => {
      const document = buildConstructionOpenApiDocument(app);
      const response = (
        document.paths?.['/v1/projects/{id}/cancel']?.post as {
          responses: Record<string, { content: unknown }>;
        }
      ).responses['422'];
      expect(response?.content).toEqual({
        'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
      });
    });
  });

  it('keeps the health probes out of the contract', () => {
    const document = buildConstructionOpenApiDocument(app);
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/health'))).toBe(
      false,
    );
  });
});
