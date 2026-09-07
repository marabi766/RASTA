// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Requiring the database client first would leave those spans
// missing entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadSupplierEnv, corsOrigins, SERVICE_NAME } from './config/env';

const env = loadSupplierEnv();

initTelemetry({
  serviceName: SERVICE_NAME,
  serviceVersion: env.SERVICE_VERSION,
  environment: env.NODE_ENV,
  namespace: env.OTEL_SERVICE_NAMESPACE,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: env.OTEL_TRACES_ENABLED,
  sampleRatio: env.NODE_ENV === 'production' ? 0.1 : 1,
});

// These imports deliberately sit below initTelemetry(). The auto-instrumentations
// patch http, pg and kafkajs as those modules load, so importing the app graph
// first would leave those spans missing entirely.
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { allowsDeveloperTooling } from '@rasta/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { enrichOpenApiDocument } from './openapi/document';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger is replaced by pino at the module level; this keeps
    // bootstrap noise out of the structured stream.
    logger: env.NODE_ENV === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
    bufferLogs: true,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(
    helmet({
      // This service serves JSON only, so the CSP can be maximally restrictive.
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
      allowedHeaders: [
        'authorization',
        'content-type',
        'x-correlation-id',
        'x-organization-id',
        'idempotency-key',
        'if-match',
      ],
      exposedHeaders: ['x-correlation-id', 'x-request-id', 'x-trace-id', 'etag'],
      maxAge: 600,
    });
  }

  // A request body large enough to matter here is a malformed or hostile one:
  // the largest legitimate payload is a qualification with twenty evidence
  // references and a two-thousand-character statement.
  app.useBodyParser('json', { limit: '256kb' });

  if (allowsDeveloperTooling(env)) {
    // Nest derives paths, methods and security from the decorators but cannot
    // see a Zod schema, so the payload shapes are filled in afterwards from the
    // very schemas the service validates with (src/openapi/document.ts).
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rasta — Supplier Service')
        .setDescription(
          'Supplier, workshop and contractor profiles, and the explicit human qualification ' +
            'and suspension decisions taken over them. An approval records that a named ' +
            'platform operator approved a submission at a stated time; it does not assert ' +
            'that any evidence document was fetched, opened, scanned or found authentic, ' +
            'current or legally valid — this service stores opaque document identifiers and ' +
            'never resolves them. No performance score is calculated, returned or published: ' +
            'the formula and its weights are an open question (docs/24 Q-12).',
        )
        .setVersion(env.SERVICE_VERSION)
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, enrichOpenApiDocument(document));
  }

  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  console.warn(
    `[${SERVICE_NAME}] listening on :${env.PORT} (${env.NODE_ENV})` +
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
