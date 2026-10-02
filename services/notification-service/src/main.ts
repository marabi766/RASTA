// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Importing the app graph first would leave those spans missing
// entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadNotificationEnv, corsOrigins, SERVICE_NAME } from './config/env';
import { assertNoMigratorCredentials } from '@rasta/config';

// D-045: a service never holds its database owner's credential. Refuse to start,
// before anything is loaded or connected, if one reached this environment
// (@rasta/config owner-credentials.ts).
assertNoMigratorCredentials(process.env);

const env = loadNotificationEnv();

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
import helmet from 'helmet';
import { SwaggerModule } from '@nestjs/swagger';
import { installGracefulShutdown, preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from './generated/prisma';
import { AppModule } from './app.module';
import { buildNotificationOpenApiDocument } from './openapi/document';

async function bootstrap(): Promise<void> {
  // D-045: refuse to start as anything but the runtime role before Nest builds a
  // single provider. Nest runs every provider's onModuleInit before AppModule's,
  // and a consumer or a timer starts in its own — gated only there, it could take
  // and commit work under an owner connection first (Codex on #178). A
  // short-lived connection of its own; AppModule still checks, belt and braces.
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_NOTIFICATION' },
  );

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

  // No endpoint here accepts a body — every write is a parameterless POST —
  // so the bound exists for the first one that does, rather than leaving it to
  // the framework default.
  app.useBodyParser('json', { limit: '64kb' });

  // The published contract, served outside production only (docs/api/README.md).
  // Built by the same function the committed document and
  // `test/openapi.int-spec.ts` use, so /docs, the file and the test cannot
  // describe three different services.
  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, buildNotificationOpenApiDocument(app));
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

  // Says what it is, and what it is not. This line is where an operator looks
  // first: in-app delivery is live (NTF-001); no email has ever been sent from
  // this platform and no provider has been chosen (ADR-054 § 6, Q-37).
  console.warn(
    `[${SERVICE_NAME}] listening on :${env.PORT} (${env.NODE_ENV}) — ` +
      'in-app notifications from INSURANCE_EXPIRING, INSPECTION_EXPIRING and MAINTENANCE_DUE, ' +
      'read API at /v1/notifications; no email channel',
  );
}

bootstrap().catch((error) => {
  console.error(`[${SERVICE_NAME}] failed to start`, error);
  process.exit(1);
});
