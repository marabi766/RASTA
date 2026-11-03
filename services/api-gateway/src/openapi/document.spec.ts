import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  AllExceptionsFilter,
  RequestContextMiddleware,
  RastaError,
  probeExceptionProblems,
  httpErrorBodyProblems,
  PROBE_TRACEPARENT,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import request from 'supertest';
import { AppModule } from '../app.module';
import {
  DocumentationModule,
  buildDocumentationApp,
  buildGatewayOpenApiDocument,
} from './document';
import { RateLimiter } from '../proxy/rate-limiter';

describe('api-gateway published errors (D-121)', () => {
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
    document = buildGatewayOpenApiDocument(app);
    app.get(RateLimiter).isHealthy = async () => {
      throw new RastaError('INTERNAL_ERROR', 'Refused');
    };
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every runtime controller (including excluded controllers)', () => {
    expect(Reflect.getMetadata('controllers', DocumentationModule)).toEqual(
      Reflect.getMetadata('controllers', AppModule),
    );
  });

  it('publishes the envelope on every error without probe exceptions', () => {
    expect(probeExceptionProblems(document, 'api-gateway', [])).toEqual([]);
  });

  it.each([false, true])('accepts a real HTTP filter body, traced=%s', async (traced) => {
    app.get(RateLimiter).isHealthy = async () => {
      throw new RastaError('INTERNAL_ERROR', 'Refused');
    };
    const sent = request(app.getHttpServer()).get('/health/ready');
    if (traced) sent.set('traceparent', PROBE_TRACEPARENT);
    const response = await sent.expect(500);
    expect(
      httpErrorBodyProblems(document, {
        method: 'GET',
        url: '/health/ready',
        status: 500,
        body: response.body,
        traced,
      }),
    ).toEqual([]);
  });
});
