// -----------------------------------------------------------------------------
// `pnpm dev` only: main.ts's telemetry prologue, run before main.ts is loaded.
//
//   node -r @swc-node/register -r ./dev/telemetry.ts … src/main.ts
//
// swc-node compiles main.ts with ES import semantics, which hoist every import
// above the module body: `./app.module` — and kafkajs, pg and http behind it —
// would load before main.ts's own initTelemetry() runs, so the
// auto-instrumentations would never patch them (Codex on #281). The built
// service is unaffected: tsc keeps main.ts's statement order, and this file is
// not part of the build.
//
// main.ts then runs the same statements again: the guard and the environment
// load repeat harmlessly, and initTelemetry() returns the SDK already started.
// scripts/service-dev-loader.test.mjs keeps them equal to main.ts's and proves
// the order.
// -----------------------------------------------------------------------------
import { initTelemetry } from '@rasta/observability';
import { loadOrganizationEnv, SERVICE_NAME } from '../src/config/env';
import { assertNoMigratorCredentials } from '@rasta/config';

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
