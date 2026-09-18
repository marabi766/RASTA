import 'reflect-metadata';
import {
  Controller,
  Get,
  type INestApplication,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  RastaError,
  RolesGuard,
} from '@rasta/nest-common';
import { metricsContentType } from '@rasta/observability';
import request from 'supertest';
import type { Server } from 'node:http';
import { MetricsController } from './metrics.controller';

/**
 * The scrape target over HTTP, behind the same global guards the service runs.
 *
 * Asserted through a request rather than by calling `metricsText()`, because
 * what can break is the route: a missing `@Public` answers a scraper `401`, a
 * lost header makes Prometheus refuse the body, and neither shows up in the
 * registry. That the controller is actually registered is pinned separately,
 * by the exact controller list in `app.module.spec.ts`, and against the real
 * composition root by `test/openapi.int-spec.ts`.
 *
 * The token verifier refuses everything, so a route that answers here answers
 * because it is public — not because a stub let a caller through.
 */

/** A closed route beside the scrape target: the negative control. */
@Controller({ path: 'closed', version: VERSION_NEUTRAL })
class ClosedController {
  @Get()
  closed(): string {
    return 'never';
  }
}

describe('audit-service metrics route', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController, ClosedController],
      providers: [
        {
          provide: AUTH_OPTIONS,
          useValue: {
            serviceName: 'audit-service',
            tokenVerifier: {
              verifyUserToken: async () => {
                throw RastaError.unauthenticated('Token is not verifiable');
              },
            },
          },
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        // The service's own filter, so a refusal carries the status it would
        // in production rather than Nest's generic 500 for an unknown error.
        {
          provide: EXCEPTION_FILTER_LOGGER,
          useValue: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // As in `main.ts`, so "version-neutral" is asserted under URI versioning.
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers a scraper that carries no token', async () => {
    const response = await request(server).get('/metrics');

    expect(response.status).toBe(200);
  });

  it('keeps the guards in force for everything else', async () => {
    // Without this the test above would pass just as well with no guard at all.
    expect((await request(server).get('/closed')).status).toBe(401);
  });

  it('serves the Prometheus text exposition content type', async () => {
    const response = await request(server).get('/metrics');

    // Compared as a media type plus a parameter set: Express re-serialises the
    // header and may reorder `charset` and `version`, which Prometheus accepts.
    const parts = (header: string): string[] =>
      header
        .split(';')
        .map((part) => part.trim().toLowerCase())
        .sort();

    expect(metricsContentType).toContain('text/plain');
    expect(metricsContentType).toContain('version=0.0.4');
    expect(parts(String(response.headers['content-type']))).toEqual(parts(metricsContentType));
  });

  it('exposes the audit series this service registers', async () => {
    const response = await request(server).get('/metrics');

    // One from each family: ingestion, capacity, query and chain verification.
    for (const name of [
      'rasta_audit_records_ingested_total',
      'rasta_audit_partition_rows',
      'rasta_audit_queries_total',
      'rasta_audit_chain_verifications_total',
    ]) {
      expect(response.text).toContain(`# HELP ${name} `);
      expect(response.text).toContain(`# TYPE ${name} `);
    }
  });

  it('is a single version-neutral GET, and not a write', async () => {
    expect((await request(server).get('/v1/metrics')).status).toBe(404);
    expect((await request(server).post('/metrics')).status).toBe(404);
  });

  it('is excluded from the published contract', () => {
    // `@ApiExcludeController()` stores this flag; the real document's path set
    // is asserted against the running service in `test/openapi.int-spec.ts`.
    expect(Reflect.getMetadata('swagger/apiExcludeController', MetricsController)).toEqual([true]);
  });
});
