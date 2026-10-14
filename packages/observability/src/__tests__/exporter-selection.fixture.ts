/**
 * The child-process half of `exporter-selection.spec.ts`.
 *
 * Starts telemetry one of two ways, under whatever `OTEL_*` environment the
 * spec gave it, ends two spans whose `url.full` carries "abc" in its query and
 * shuts down, which flushes every exporter:
 *
 *   baseline  `initTelemetry`'s NodeSDK setup before #261, verbatim.
 *   current   `initTelemetry` as it is.
 *
 * OTLP exports go to the spec's collectors, which record them; console
 * exports are caught here. stdout reports whether spans were recorded at all,
 * what the console exporter printed and whether shutdown failed.
 *
 * argv: <mode> [explicit otlpEndpoint]
 */
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { RastaSampler, initTelemetry, shutdownTelemetry, type TelemetryConfig } from '../telemetry';

const SPAN_COUNT = 2;

/** `initTelemetry` at c73a55ac, the commit #261 branched from, verbatim but for the singleton. */
function baselineInitTelemetry(config: TelemetryConfig): NodeSDK {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
    'service.namespace': config.namespace ?? 'rasta',
    'deployment.environment': config.environment ?? process.env.NODE_ENV ?? 'development',
  });

  const sdk = new NodeSDK({
    resource,
    sampler: new RastaSampler(config.sampleRatio ?? 1),
    traceExporter: config.otlpEndpoint
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint.replace(/\/$/, '')}/v1/traces` })
      : undefined,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const url = request.url ?? '';
            return url.startsWith('/health') || url.startsWith('/metrics');
          },
        },
      }),
    ],
  });

  sdk.start();
  return sdk;
}

async function main(): Promise<void> {
  const [mode, otlpEndpoint] = process.argv.slice(1);
  const config: TelemetryConfig = { serviceName: 'exporter-selection-fixture', otlpEndpoint };

  const printed: string[] = [];
  // ConsoleSpanExporter writes each span with console.dir; this catches the
  // output rather than writing any.
  // eslint-disable-next-line no-console
  console.dir = (item: unknown): void => {
    printed.push(JSON.stringify(item));
  };

  let shutdown: () => Promise<void>;
  if (mode === 'baseline') {
    const sdk = baselineInitTelemetry(config);
    shutdown = () => sdk.shutdown();
  } else {
    initTelemetry(config);
    shutdown = shutdownTelemetry;
  }

  const tracer = trace.getTracer('exporter-selection');
  let recording = false;
  for (let i = 0; i < SPAN_COUNT; i += 1) {
    const span = tracer.startSpan('GET', {
      attributes: { 'url.full': 'http://h/v1/x?secret=abc' },
    });
    recording ||= span.isRecording();
    span.end();
  }
  // A failed export surfaces here; it is part of the outcome being compared.
  const shutdownError = await shutdown().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  process.stdout.write(JSON.stringify({ recording, printed, shutdownError }));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
