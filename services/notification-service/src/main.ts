// -----------------------------------------------------------------------------
// Telemetry must be initialised before anything else is imported.
//
// The OpenTelemetry auto-instrumentations patch modules (http, pg, kafkajs) as
// they load. Importing the app graph first would leave those spans missing
// entirely — a silent gap that is confusing to diagnose later.
// -----------------------------------------------------------------------------
import { initTelemetry, shutdownTelemetry } from '@rasta/observability';
import { loadNotificationEnv, corsOrigins, SERVICE_NAME } from './config/env';

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
import { AppModule } from './app.module';

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

  // Nothing here accepts a body — the only routes are two GET probes. The limit
  // is set anyway so the first endpoint that does accept one inherits a bound
  // rather than the framework default.
  app.useBodyParser('json', { limit: '64kb' });

  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  // Says what it is. A service answering health checks and nothing else is easy
  // to mistake for a working one, and this line is where an operator looks
  // first (ADR-054 is Proposed; NTF-001 has not started).
  console.warn(
    `[${SERVICE_NAME}] listening on :${env.PORT} (${env.NODE_ENV}) — ` +
      'bootstrap scaffold: health probes only, no notification delivery',
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
