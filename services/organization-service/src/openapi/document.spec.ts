import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  AllExceptionsFilter,
  RequestContextMiddleware,
  RastaError,
  probeExceptionProblems,
  errorEnvelopeProblems,
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
  organizationRouteDocument,
  ORGANIZATION_PROBE_EXCEPTIONS,
  buildOrganizationOpenApiDocument,
  buildScopedOpenApiDocument,
  formatDocument,
} from './document';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';
import { OrganizationService } from '../organization/organization.service';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('organization-service published errors (D-121)', () => {
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
    document = buildOrganizationOpenApiDocument(app);
    app.get(PrismaService).isHealthy = async () => false;
    app.get(KafkaEventPublisher).isHealthy = async () => false;
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
        declared: organizationRouteDocument(app),
        probeExceptions: ORGANIZATION_PROBE_EXCEPTIONS,
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
    const response = await request(app.getHttpServer()).get('/health/startup').expect(503);
    startupBodies.push(response.body);
    expect(
      probeExceptionProblems(
        document,
        'organization-service',
        [
          {
            service: 'organization-service',
            path: '/health/ready',
            status: 503,
            bodies: readyBodies,
          },
          {
            service: 'organization-service',
            path: '/health/startup',
            status: 503,
            bodies: startupBodies,
          },
        ],
        { declared: organizationRouteDocument(app) },
      ),
    ).toEqual([]);
  });

  it.each([false, true])('accepts a real HTTP filter body, traced=%s', async (traced) => {
    app.get(OrganizationService).list = async () => {
      throw new RastaError('INTERNAL_ERROR', 'Refused');
    };
    const sent = request(app.getHttpServer()).get('/v1/organizations');
    if (traced) sent.set('traceparent', PROBE_TRACEPARENT);
    const response = await sent.expect(500);
    expect(
      httpErrorBodyProblems(document, {
        method: 'GET',
        url: '/v1/organizations',
        status: 500,
        body: response.body,
        traced,
      }),
    ).toEqual([]);
  });

  it('matches the generator byte for byte', () => {
    const path = resolve(__dirname, '../../../../docs/api/organization-service.openapi.json');
    expect(errorEnvelopeProblems(buildScopedOpenApiDocument(app))).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(formatDocument(buildScopedOpenApiDocument(app), path));
  });
  it('validates a real service-pipe refusal against the published default', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/organizations')
      .send({})
      .expect(400);
    expect(
      httpErrorBodyProblems(document, {
        method: 'POST',
        url: '/v1/organizations',
        status: 400,
        body: response.body,
        traced: false,
      }),
    ).toEqual([]);
  });
});
