// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Requiring the database client first would leave those spans
// missing entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadOrganizationEnv, corsOrigins, SERVICE_NAME } from './config/env';
import { assertNoMigratorCredentials } from '@rasta/config';

// D-045: a service never holds its database owner's credential. Refuse to start,
// before anything is loaded or connected, if one reached this environment
// (@rasta/config owner-credentials.ts).
assertNoMigratorCredentials(process.env);

const env = loadOrganizationEnv();

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
import { installGracefulShutdown, preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from './generated/prisma';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // D-045: refuse to start as anything but the runtime role before Nest builds a
  // single provider. Nest runs every provider's onModuleInit before AppModule's,
  // and a consumer or a timer starts in its own — gated only there, it could take
  // and commit work under an owner connection first (Codex on #178). A
  // short-lived connection of its own; AppModule still checks, belt and braces.
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_ORGANIZATION' },
  );

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

  // A request body large enough to matter here is a malformed or hostile one.
  app.useBodyParser('json', { limit: '256kb' });

  if (allowsDeveloperTooling(env)) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rasta — Organization Service')
        .setDescription(
          'Generic, extensible organization model and hierarchy. Deliberately knows ' +
            'nothing about dehyaris: an organization has a type, and the type is data.',
        )
        .setVersion(env.SERVICE_VERSION)
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  // The one shutdown path (`installGracefulShutdown`, @rasta/nest-common): close
  // the app so Nest's hooks finish, flush telemetry, then exit 0 — or 1 if the
  // close fails or outlasts SHUTDOWN_TIMEOUT_MS. No `enableShutdownHooks()`
  // beside it: two competing paths let the exit cut an in-flight batch off.
  installGracefulShutdown(app, {
    serviceName: SERVICE_NAME,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    afterClose: shutdownTelemetry,
  });

  await app.listen(env.PORT, '0.0.0.0');

  console.warn(
    `[${SERVICE_NAME}] listening on :${env.PORT} (${env.NODE_ENV})` +
      (allowsDeveloperTooling(env) ? ` — docs at http://localhost:${env.PORT}/docs` : ''),
  );
}

bootstrap().catch((error) => {
  console.error(`[${SERVICE_NAME}] failed to start`, error);
  process.exit(1);
});
