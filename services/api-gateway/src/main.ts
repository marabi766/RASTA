// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Requiring the database client first would leave those spans
// missing entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadGatewayEnv, corsOrigins, SERVICE_NAME } from './config/env';
import { assertNoMigratorCredentials } from '@rasta/config';

// D-045: a service never holds its database owner's credential. Refuse to start,
// before anything is loaded or connected, if one reached this environment
// (@rasta/config owner-credentials.ts).
assertNoMigratorCredentials(process.env);

const env = loadGatewayEnv();

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
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { allowsDeveloperTooling } from '@rasta/config';
import helmet from 'helmet';
import { installGracefulShutdown } from '@rasta/nest-common';
import { AppModule } from './app.module';
import { applyTrustProxy } from './http/trust-proxy';
import { corsOptions } from './http/cors';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger is replaced by pino at the module level; this keeps
    // bootstrap noise out of the structured stream.
    logger: env.NODE_ENV === 'development' ? ['log', 'warn', 'error'] : ['warn', 'error'],
    bufferLogs: true,
  });

  // Before any middleware reads `req.ip`: the request-context middleware
  // records it for audit, and anonymous rate limits key on it (L1-03).
  applyTrustProxy(app, env.GATEWAY_TRUSTED_PROXIES);

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
    app.enableCors(corsOptions(origins));
  }

  // A request body large enough to matter here is a malformed or hostile one.
  app.useBodyParser('json', { limit: '256kb' });

  if (allowsDeveloperTooling(env)) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Rasta — API Gateway')
        .setDescription(
          'The single entry point for external traffic. Authenticates, resolves the ' +
            'tenant, rate limits and routes. Holds no business logic and no database.',
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
