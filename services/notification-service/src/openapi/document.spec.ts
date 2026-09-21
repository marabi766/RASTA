import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  buildDocumentationApp,
  buildNotificationOpenApiDocument,
  CONTRACT_VERSION,
  ERROR_DESCRIPTIONS,
  formatDocument,
} from './document';

/**
 * The committed contract is exactly what the generator produces.
 *
 * `docs/api/notification-service.openapi.json` is checked in so a breaking
 * change shows in a PR's diff. This spec regenerates it from the same
 * documentation module the generator boots and requires the bytes to match,
 * which is what turns "remember to regenerate" into a failing test. The
 * *runtime* half — that the document describes the real application with
 * its real guards — is `test/openapi.int-spec.ts`.
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
    'notification-service.openapi.json',
  );

  it('matches the generator byte for byte (run `pnpm openapi:generate` after changing the API)', async () => {
    const generated = formatDocument(buildNotificationOpenApiDocument(app), committedPath);
    const committed = readFileSync(committedPath, 'utf8');
    expect(committed).toBe(generated);
  });

  it('publishes the eleven endpoints, all closed, all answering 200', () => {
    const document = buildNotificationOpenApiDocument(app);
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(
        item as Record<string, { security?: unknown; responses: Record<string, unknown> }>,
      ).map(([method, operation]) => ({ key: `${method.toUpperCase()} ${path}`, operation })),
    );
    expect(operations.map((o) => o.key).sort()).toEqual([
      'GET /v1/notifications',
      'GET /v1/notifications/unread-count',
      'GET /v1/notifications/{id}',
      // NTF-003 adds three, under the same rule as the six above: closed by
      // default, no `@AllowService`, and the caller's own rows only.
      'GET /v1/preferences',
      'GET /v1/preferences/effective',
      // NTF-004 adds the quiet window NTF-003 deferred, under the same rule
      // again: the caller's own, and nobody else's.
      'GET /v1/preferences/quiet-hours',
      'POST /v1/notifications/read-all',
      'POST /v1/notifications/{id}/dismiss',
      'POST /v1/notifications/{id}/read',
      'PUT /v1/preferences',
      'PUT /v1/preferences/quiet-hours',
    ]);
    for (const { operation } of operations) {
      expect(operation.security).toEqual([{ bearer: [] }]);
      expect(operation.responses['200']).toBeDefined();
      expect(operation.responses['201']).toBeUndefined();
      for (const status of Object.keys(ERROR_DESCRIPTIONS))
        expect(operation.responses[status]).toBeDefined();
    }
    expect(document.info.version).toBe(CONTRACT_VERSION);
    // The description said "No email is sent by this platform" until NTF-004.
    // It has to keep saying what is still true — that nothing here points at a
    // real recipient — without saying the part that no longer is.
    expect(document.info.description).toContain('Q-37');
    expect(document.info.description).toContain('deliversToRealRecipients as false');
    expect(document.info.description).not.toContain('No email is sent');
  });

  it('publishes `limit`, `cursor` and `state` on the list and `id` as a required path parameter', () => {
    const document = buildNotificationOpenApiDocument(app);
    const list = (
      document.paths['/v1/notifications'] as {
        get: { parameters: { name: string; required: boolean }[] };
      }
    ).get;
    expect(list.parameters.map((p) => `${p.name}${p.required ? '*' : ''}`).sort()).toEqual([
      'cursor',
      'limit',
      'state',
    ]);
    const detail = (
      document.paths['/v1/notifications/{id}'] as {
        get: { parameters: { name: string; required: boolean; schema: { maxLength?: number } }[] };
      }
    ).get;
    expect(detail.parameters).toEqual([
      expect.objectContaining({
        name: 'id',
        required: true,
        schema: expect.objectContaining({ maxLength: 64 }),
      }),
    ]);
  });
});
