import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  consumerFailures,
  AllExceptionsFilter,
  RequestContextMiddleware,
  RastaError,
  probeExceptionProblems,
  httpErrorBodyProblems,
  PROBE_TRACEPARENT,
  routeErrorProblems,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import request from 'supertest';
import { AppModule } from '../app.module';
import {
  DocumentationModule,
  buildDocumentationApp,
  identityRouteDocument,
  buildIdentityOpenApiDocument,
  formatDocument,
} from './document';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { IdentityService } from '../identity/identity.service';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('identity-service published errors (D-121)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await buildDocumentationApp((app) => {
      app.useGlobalFilters(
        new AllExceptionsFilter({
          debug() {},
          info() {},
          warn() {},
          error() {},
        } as unknown as Logger),
      );
      const middleware = new RequestContextMiddleware();
      app.use(middleware.use.bind(middleware));
    });
    document = buildIdentityOpenApiDocument(app);
    app.get(PrismaService).isHealthy = async () => false;
    app.get(KafkaEventPublisher).isHealthy = async () => false;
    app.get(KeycloakAdminClient).isHealthy = async () => false;
  });

  afterAll(async () => {
    await app.close();
  });

  it('holds the routes the app really serves, and their real error answers, against the document (FU-031)', async () => {
    const send = async (method: string, url: string) => {
      const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const response = await request(app.getHttpServer())[verb](url);
      return { status: response.status, body: response.body as unknown };
    };
    expect(
      await routeErrorProblems(app, document, {
        declared: identityRouteDocument(app),
        send,
      }),
    ).toEqual([]);
  });

  it('documents every runtime controller (including excluded controllers)', () => {
    expect(Reflect.getMetadata('controllers', DocumentationModule)).toEqual(
      Reflect.getMetadata('controllers', AppModule),
    );
  });

  it('accepts real filter bodies on every error and real health bodies only at the explicit exceptions', async () => {
    const readyBodies: unknown[] = [];
    for (const kafka of [false, true]) {
      app.get(KafkaEventPublisher).isHealthy = async () => kafka;
      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);
      readyBodies.push(response.body);
    }
    const startupBodies: unknown[] = [];
    for (const [database, keycloak] of [
      [false, false],
      [false, true],
      [true, false],
    ]) {
      app.get(PrismaService).isHealthy = async () => database;
      app.get(KeycloakAdminClient).isHealthy = async () => keycloak;
      const response = await request(app.getHttpServer()).get('/health/startup').expect(503);
      startupBodies.push(response.body);
    }
    expect(
      probeExceptionProblems(
        document,
        'identity-service',
        [
          { service: 'identity-service', path: '/health/ready', status: 503, bodies: readyBodies },
          {
            service: 'identity-service',
            path: '/health/startup',
            status: 503,
            bodies: startupBodies,
          },
        ],
        { declared: identityRouteDocument(app) },
      ),
    ).toEqual([]);
  });

  it.each([false, true])('accepts a real HTTP filter body, traced=%s', async (traced) => {
    app.get(IdentityService).getCurrentUser = async () => {
      throw new RastaError('INTERNAL_ERROR', 'Refused');
    };
    const sent = request(app.getHttpServer()).get('/v1/users/me');
    if (traced) sent.set('traceparent', PROBE_TRACEPARENT);
    const response = await sent.expect(500);
    expect(
      httpErrorBodyProblems(document, {
        method: 'GET',
        url: '/v1/users/me',
        status: 500,
        body: response.body,
        traced,
      }),
    ).toEqual([]);
  });

  it('matches the generator byte for byte', () => {
    const path = resolve(__dirname, '../../../../docs/api/identity-service.openapi.json');
    expect(readFileSync(path, 'utf8')).toBe(formatDocument(document, path));
  });
  it('validates a real service-pipe refusal against the published default', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/users/me/active-organization')
      .send({})
      .expect(400);
    expect(
      httpErrorBodyProblems(document, {
        method: 'POST',
        url: '/v1/users/me/active-organization',
        status: 400,
        body: response.body,
        traced: false,
      }),
    ).toEqual([]);
  });

  it.each(['live', 'ready'])(
    'also accepts the real consumer-crash envelope at /health/%s',
    async (probe) => {
      const failed = jest.spyOn(consumerFailures, 'isHealthy').mockReturnValue(false);
      try {
        const url = `/health/${probe}`;
        const response = await request(app.getHttpServer()).get(url).expect(503);
        expect(
          httpErrorBodyProblems(document, {
            method: 'GET',
            url,
            status: 503,
            body: response.body,
            traced: false,
          }),
        ).toEqual([]);
      } finally {
        failed.mockRestore();
      }
    },
  );
});
