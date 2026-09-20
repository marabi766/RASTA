import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  buildNotificationOpenApiDocument,
  ERROR_DESCRIPTIONS,
  formatDocument,
} from '../src/openapi/document';
import { cleanup, newOrganizationId, newUserId } from './helpers';
import {
  internalToken,
  seedNotification,
  startApi,
  userToken,
  type ApiHarness,
} from './api-helpers';

/**
 * The published contract, checked against the service that answers it.
 *
 * Two things are asserted, and the second is the one that decays without a
 * test:
 *
 *   **The committed document is the real application's.** Built here from
 *   the booted `AppModule` — real guards, real pipes, real router — and
 *   required to equal `docs/api/notification-service.openapi.json` byte for
 *   byte. The unit spec proves the generator's module produces that file;
 *   this proves the generator's module and the real one route the same.
 *
 *   **Every documented status is reachable.** Each error the document lists
 *   is produced by a real request against the real guards. A `409` nobody can
 *   provoke would be a documented lie, and a status the service answers but
 *   never documents leaves a client with no branch for it.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let document: OpenAPIObject;
  const organizations: string[] = [];
  let org: string;
  let me: string;
  let ownRow: string;

  const PATHS = [
    'GET /v1/notifications',
    'GET /v1/notifications/unread-count',
    'POST /v1/notifications/read-all',
    'GET /v1/notifications/{id}',
    'POST /v1/notifications/{id}/read',
    'POST /v1/notifications/{id}/dismiss',
    // NTF-003. Same rule as the six above: closed by default, self-only.
    'GET /v1/preferences',
    'PUT /v1/preferences',
    'GET /v1/preferences/effective',
  ];

  beforeAll(async () => {
    api = await startApi();
    document = buildNotificationOpenApiDocument(api.app);
    org = newOrganizationId();
    organizations.push(org);
    me = newUserId();
    ownRow = (await seedNotification(api.prisma, { organizationId: org, userId: me })).id;
  }, 120_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  }, 120_000);

  it('is exactly the committed document', async () => {
    const committedPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'api',
      'notification-service.openapi.json',
    );
    expect(formatDocument(document, committedPath)).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('describes exactly the routes the application answers on, each closed', () => {
    const published = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(published.sort()).toEqual([...PATHS].sort());
    for (const [, item] of Object.entries(document.paths ?? {})) {
      for (const operation of Object.values(item as Record<string, { security?: unknown }>)) {
        expect(operation.security).toEqual([{ bearer: [] }]);
      }
    }
    // The health probes are not in the contract: they are orchestrator
    // plumbing, and publishing them would describe them as bearer-protected.
    expect(document.paths?.['/health/ready']).toBeUndefined();
  });

  it('documents every status the service answers, and every documented status is reachable', async () => {
    const reached = new Set<number>();
    const token = userToken(me, org);

    reached.add(
      (
        await request(api.server)
          .get(`/v1/notifications/${ownRow}`)
          .set('authorization', `Bearer ${token}`)
      ).status,
    ); // 200
    reached.add(
      (
        await request(api.server)
          .get('/v1/notifications?limit=999')
          .set('authorization', `Bearer ${token}`)
      ).status,
    ); // 400
    reached.add((await request(api.server).get('/v1/notifications')).status); // 401
    reached.add(
      (
        await request(api.server)
          .get('/v1/notifications')
          .set('x-internal-token', await internalToken('marketplace-service', 'SERVICE', org))
      ).status,
    ); // 403
    reached.add(
      (
        await request(api.server)
          .get(`/v1/notifications/NTN_${ulid()}`)
          .set('authorization', `Bearer ${token}`)
      ).status,
    ); // 404

    const documented = new Set(Object.keys(ERROR_DESCRIPTIONS).map(Number));
    // 500 is documented and deliberately not provoked: a real one is a defect,
    // and faking one would test the fake.
    documented.delete(500);
    expect([...documented].sort()).toEqual([400, 401, 403, 404]);
    for (const status of documented) expect(reached).toContain(status);
    expect(reached).toContain(200);
  });

  it('publishes the list parameters as the schema validates them', () => {
    const list = (
      document.paths?.['/v1/notifications'] as {
        get: {
          parameters: { name: string; required?: boolean; schema: Record<string, unknown> }[];
        };
      }
    ).get;
    const byName = new Map(list.parameters.map((p) => [p.name, p]));
    expect(byName.get('limit')?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 25,
    });
    expect(byName.get('state')?.schema).toMatchObject({ enum: ['UNREAD', 'READ', 'DISMISSED'] });
    expect(byName.get('cursor')?.required).toBe(false);
  });
});
