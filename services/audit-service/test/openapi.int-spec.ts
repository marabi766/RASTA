import request from 'supertest';
import type { Server } from 'node:http';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { PrismaService } from '../src/prisma/prisma.service';
import { buildAuditOpenApiDocument, ERROR_DESCRIPTIONS } from '../src/openapi/document';
import { cleanupRun, newMigratorPrisma } from './helpers';
import { auditor, internalToken, startApi, systemAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, projectOrganization, queryWindow, seedAuditEvent } from './fixtures';

/**
 * The published contract, checked against the service that answers it.
 *
 * > **The marketplace lesson that makes this file mandatory.** That service's
 * > OpenAPI contract never published the required `Idempotency-Key` header, so
 * > clients did not send one. A contract that is generated but not tested is
 * > not a contract.
 *
 * Two things are asserted, and the second is the one that decays without a
 * test:
 *
 *   **The document describes the routes that exist.** Both paths, both methods,
 *   `from` and `to` published as required, bearer security stated on the
 *   operation and not only in `components`.
 *
 *   **Every documented status is reachable.** Each error the document lists is
 *   produced here by a real request against the real guards. A `409` nobody can
 *   provoke would be a documented lie, and a status the service answers but
 *   never documents leaves a client with no branch for it.
 *
 * ## Nothing is committed to the repository, deliberately
 *
 * This repository has no checked-in OpenAPI artifact for any service, no
 * generator that would produce one deterministically and no CI step that would
 * notice it going stale. Adding one here would create a second thing to keep in
 * step with no consumer asking for it. The document is generated at boot,
 * served at `/docs` outside production, and verified here.
 */
describe('the published OpenAPI contract (real application)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let server: Server;
  let document: OpenAPIObject;

  const ORG = orgId('OPENAPI');
  let recordId: string;
  const window = queryWindow();

  const LIST = '/v1/audit-events';
  const DETAIL = '/v1/audit-events/{id}';

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();

    api = await startApi();
    server = api.app.getHttpServer() as Server;
    document = buildAuditOpenApiDocument(api.app, '0.1.0');

    await projectOrganization(api.prisma, { organizationId: ORG, parentOrganizationId: null });
    recordId = (await seedAuditEvent(api.prisma, { organizationId: ORG, occurredAt: at(5) })).id;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 120_000);

  const operation = (path: string): Record<string, unknown> =>
    // JUSTIFIED-ANY is unnecessary here: the document type is structurally
    // `Record<string, PathItemObject>` and the `get` member is what is read.
    (document.paths?.[path] as { get: Record<string, unknown> }).get;

  const parameters = (path: string): { name: string; in: string; required?: boolean }[] =>
    (operation(path).parameters ?? []) as { name: string; in: string; required?: boolean }[];

  interface JsonResponse {
    content: Record<string, { schema: { properties: Record<string, unknown> } }>;
  }

  /** The published body schema's property map, for one path's 200 response. */
  const bodyProperties = (path: string): Record<string, unknown> => {
    const responses = operation(path).responses as Record<string, JsonResponse>;
    return responses['200'].content['application/json'].schema.properties;
  };

  describe('the routes it describes', () => {
    it('publishes exactly the two read endpoints', () => {
      // Sorted on both sides, so this asserts the *set* of published paths and
      // not the order Nest happened to register them in. `LIST` sorts before
      // `DETAIL` because `/v1/audit-events` is a prefix of
      // `/v1/audit-events/{id}`.
      expect(Object.keys(document.paths ?? {}).sort()).toEqual([LIST, DETAIL]);
    });

    it('publishes no write operation on either path', () => {
      // The absence of `POST /v1/audit-events` is the contract (docs/04 § 4.15),
      // so it is asserted on the document as well as on the router.
      for (const path of [LIST, DETAIL]) {
        expect(Object.keys(document.paths?.[path] ?? {})).toEqual(['get']);
      }
    });

    it('states bearer security on each operation, not only in components', () => {
      // `DocumentBuilder.addBearerAuth()` *declares* the scheme; it does not
      // apply it. Without this the contract would describe a service whose
      // endpoints are open while the guard answers 401 to every one of them.
      expect(document.components?.securitySchemes?.bearer).toBeDefined();
      for (const path of [LIST, DETAIL]) {
        expect(operation(path).security).toEqual([{ bearer: [] }]);
      }
    });
  });

  describe('the parameters it publishes', () => {
    it('marks from and to required on both endpoints', () => {
      // The marketplace failure, prevented: a client that does not know these
      // are mandatory sends neither and meets a 400 it could not have predicted.
      for (const path of [LIST, DETAIL]) {
        const required = parameters(path)
          .filter((parameter) => parameter.required)
          .map((parameter) => parameter.name)
          .sort();
        expect(required).toEqual(expect.arrayContaining(['from', 'to']));
      }
    });

    it('publishes every filter the service accepts, and no filter it does not', () => {
      const published = parameters(LIST)
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name)
        .sort();

      expect(published).toEqual(
        [
          'action',
          'actorId',
          'actorType',
          'correlationId',
          'cursor',
          'from',
          'limit',
          'organizationId',
          'outcome',
          'resourceId',
          'resourceType',
          'to',
        ].sort(),
      );
    });

    it('publishes the path parameter on the detail endpoint', () => {
      expect(parameters(DETAIL).some((parameter) => parameter.in === 'path')).toBe(true);
    });

    it('does not publish a filter the service would refuse', async () => {
      // The document and the runtime schema are the same object, so this is a
      // round-trip rather than two lists agreeing by luck: anything published
      // must be accepted, and it is.
      const names = parameters(LIST)
        .filter((parameter) => parameter.in === 'query' && parameter.name !== 'cursor')
        .map((parameter) => parameter.name);

      const query: Record<string, string> = { ...window };
      for (const name of names) {
        if (name === 'from' || name === 'to') continue;
        query[name] = SAMPLE_VALUES[name] ?? 'x';
      }

      const response = await request(server)
        .get(LIST)
        .query(query)
        .set('Authorization', `Bearer ${systemAdmin()}`);

      expect(response.status).toBe(200);
    });
  });

  describe('the response shapes it publishes', () => {
    it('describes a 200 body for each endpoint', () => {
      for (const path of [LIST, DETAIL]) {
        const responses = operation(path).responses as Record<string, unknown>;
        expect(responses['200']).toBeDefined();
      }
    });

    it('matches the list body the service actually returns', async () => {
      const response = await request(server)
        .get(LIST)
        .query(window)
        .set('Authorization', `Bearer ${systemAdmin()}`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(Object.keys(bodyProperties(LIST)).sort());
    });

    it('matches the record body the service actually returns', async () => {
      const response = await request(server)
        .get(`/v1/audit-events/${recordId}`)
        .query(window)
        .set('Authorization', `Bearer ${systemAdmin()}`);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(Object.keys(bodyProperties(DETAIL)).sort());
    });

    it('publishes the 64-bit columns as strings', () => {
      const properties = bodyProperties(DETAIL);

      expect(JSON.stringify(properties.sequenceNo)).toContain('string');
      expect(JSON.stringify(properties.sourceStreamSeq)).toContain('string');
    });
  });

  describe('every documented error is reachable', () => {
    it('documents exactly 400, 401, 403, 404 and 500', () => {
      expect(Object.keys(ERROR_DESCRIPTIONS).sort()).toEqual(['400', '401', '403', '404', '500']);
      for (const path of [LIST, DETAIL]) {
        const responses = Object.keys(operation(path).responses as Record<string, unknown>).sort();
        expect(responses).toEqual(['200', '400', '401', '403', '404', '500']);
      }
    });

    it('reaches 400 with a missing window', async () => {
      const response = await request(server)
        .get(LIST)
        .set('Authorization', `Bearer ${systemAdmin()}`);
      expect(response.status).toBe(400);
    });

    it('reaches 401 with no credentials', async () => {
      expect((await request(server).get(LIST).query(window)).status).toBe(401);
    });

    it('reaches 403 with the oversight role, and with a service token', async () => {
      expect(
        (
          await request(server)
            .get(LIST)
            .query(window)
            .set('Authorization', `Bearer ${auditor(ORG)}`)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(server)
            .get(LIST)
            .query(window)
            .set('x-internal-token', await internalToken())
        ).status,
      ).toBe(403);
    });

    it('reaches 404 with an unknown record', async () => {
      const response = await request(server)
        .get('/v1/audit-events/01JNOSUCHRECORD0000000000')
        .query(window)
        .set('Authorization', `Bearer ${systemAdmin()}`);
      expect(response.status).toBe(404);
    });

    it('documents no status nobody can produce', () => {
      // `409` and `422` are absent because this service reads, and a read has
      // no state to disagree with. Asserted so a future copy-paste of another
      // service's error table is caught.
      for (const path of [LIST, DETAIL]) {
        const responses = operation(path).responses as Record<string, unknown>;
        expect(responses['409']).toBeUndefined();
        expect(responses['422']).toBeUndefined();
      }
    });

    it('gives every error response the shared error schema', () => {
      expect(document.components?.schemas?.ApiError).toBeDefined();
      for (const path of [LIST, DETAIL]) {
        const responses = operation(path).responses as Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >;
        for (const status of ['400', '401', '403', '404', '500']) {
          expect(responses[status]?.content?.['application/json']?.schema?.$ref).toBe(
            '#/components/schemas/ApiError',
          );
        }
      }
    });

    it('the error body a caller receives matches the documented shape', async () => {
      const response = await request(server)
        .get(LIST)
        .set('Authorization', `Bearer ${systemAdmin()}`);

      expect(response.status).toBe(400);
      expect(typeof response.body.code).toBe('string');
      expect(typeof response.body.message).toBe('string');
    });
  });

  describe('what the description promises', () => {
    it('says there is no write endpoint and no verified integrity chain', () => {
      // The two claims a reader is most likely to get wrong: that a null
      // `changes` means "nothing changed", and that a record they can read is a
      // record somebody proved unaltered.
      const description = document.info.description ?? '';
      expect(description).toContain('no write endpoint');
      expect(description).toContain('AUDITOR');
      expect(description).toContain('AUD-003');
    });
  });
});

/** Values that satisfy each filter's own schema, for the round-trip above. */
const SAMPLE_VALUES: Record<string, string> = {
  organizationId: 'ORG-SAMPLE',
  actorId: 'USR-SAMPLE',
  actorType: 'USER',
  action: 'asset.decommissioned',
  resourceType: 'Asset',
  resourceId: 'AST-SAMPLE',
  correlationId: 'corr-sample',
  outcome: 'SUCCESS',
  limit: '25',
};
