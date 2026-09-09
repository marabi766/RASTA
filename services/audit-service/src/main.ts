// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Importing the app graph first would leave those spans missing
// entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadAuditEnv, corsOrigins, SERVICE_NAME } from './config/env';

const env = loadAuditEnv();

initTelemetry({
  serviceName: SERVICE_NAME,
  serviceVersion: env.SERVICE_VERSION,
  environment: env.NODE_ENV,
  namespace: env.OTEL_SERVICE_NAMESPACE,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_TRACES_ENABLED,
  sampleRatio: env.NODE_ENV === 'production' ? 0.1 : 1,
});

// These imports deliberately sit below initTelemetry(), for the reason above.
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { allowsDeveloperTooling } from '@rasta/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { buildAuditOpenApiDocument } from './openapi/document';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: env.NODE_ENV === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
    bufferLogs: true,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(
    helmet({
      // JSON only, so the policy can be maximally restrictive.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const origins = corsOrigins(env);
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      allowedHeaders: ['authorization', 'content-type', 'x-correlation-id', 'x-organization-id'],
      exposedHeaders: ['x-correlation-id', 'x-request-id', 'x-trace-id'],
      maxAge: 600,
    });
  }

  // Nothing here accepts a body: every route is a GET, and `docs/04` § 4.15
  // makes that permanent — writing to the audit store is from Kafka only. The
  // limit is kept so a body sent to a GET is refused at the parser rather than
  // read into memory first.
  app.useBodyParser('json', { limit: '64kb' });

  if (allowsDeveloperTooling(env)) {
    // Nest derives paths, methods and security from the decorators but cannot
    // see a Zod schema, so the parameter and response shapes are filled in
    // afterwards from the very schemas the service validates and serialises
    // with. Built by the same function `test/openapi.int-spec.ts` calls: a
    // contract generated one way and tested another is two contracts.
    SwaggerModule.setup('docs', app, buildAuditOpenApiDocument(app, env.SERVICE_VERSION));
  }

  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  // Says what it does and what it does not, because this line is where an
  // operator looks first.
  console.warn(
    `[${SERVICE_NAME}] listening on :${env.PORT} (${env.NODE_ENV}) — ` +
      'domain projector: ingesting 10 domain topics; read API: search and detail ' +
      '(no export, no integrity verification yet)' +
      (allowsDeveloperTooling(env) ? ` — docs at http://localhost:${env.PORT}/docs` : ''),
  );
}

async function shutdown(signal: string): Promise<void> {
  console.warn(`[${SERVICE_NAME}] received ${signal}, shutting down`);
  await shutdownTelemetry();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

bootstrap().catch((error) => {
  console.error(`[${SERVICE_NAME}] failed to start`, error);
  process.exit(1);
});
