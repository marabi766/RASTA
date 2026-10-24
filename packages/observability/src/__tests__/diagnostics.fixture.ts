/**
 * The child-process half of `diagnostics.spec.ts` (#385 r5).
 *
 * Starts telemetry under whatever `OTEL_*` environment the spec gave it, ends
 * two spans, awaits shutdown — which flushes, and fails, every exporter the
 * environment chose — and prints one JSON line on stdout saying how it went.
 * Everything else either stream carries is the SDK's diagnostics, which the
 * spec reads whole.
 *
 *   current   `initTelemetry` as it is.
 *   baseline  a bare NodeSDK, its console logger and all: the control that
 *             the environment really makes the SDK quote it.
 *   explicit  `initTelemetry` with argv[2] as `otlpEndpoint`; prints what it threw.
 *   exports   `initTelemetry` into an in-memory exporter: the positive control
 *             that telemetry still exports under the safe logger.
 */
import { inspect } from 'node:util';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { initTelemetry, shutdownTelemetry } from '../telemetry';

/** Everything a thrown value can print: message, stack, own properties, inspection. */
function everythingOf(value: unknown): string {
  if (!(value instanceof Error)) return inspect(value, { depth: 10 });
  return [
    value.message,
    value.stack ?? '',
    JSON.stringify(value, Object.getOwnPropertyNames(value)),
    inspect(value, { depth: 10, showHidden: true }),
    value.cause === undefined ? '' : inspect(value.cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

/** Counts what it was given: InMemorySpanExporter forgets everything on shutdown. */
class CountingExporter extends InMemorySpanExporter {
  exported = 0;

  override export(...args: Parameters<InMemorySpanExporter['export']>): void {
    this.exported += args[0].length;
    super.export(...args);
  }
}

function endSpans(): void {
  const tracer = trace.getTracer('diagnostics-fixture');
  for (let i = 0; i < 2; i += 1) tracer.startSpan(`span-${i}`).end();
}

async function main(): Promise<Record<string, unknown>> {
  const [mode, endpoint] = process.argv.slice(1);
  if (mode === 'baseline') {
    const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] });
    sdk.start();
    endSpans();
    const shutdown = await sdk.shutdown().then(
      () => 'ok',
      () => 'failed',
    );
    return { mode, shutdown };
  }
  if (mode === 'explicit') {
    try {
      initTelemetry({ serviceName: 'diagnostics-fixture', otlpEndpoint: endpoint });
      return { mode, thrown: null };
    } catch (error) {
      return { mode, thrown: everythingOf(error) };
    }
  }
  if (mode === 'exports') {
    const exporter = new CountingExporter();
    initTelemetry({ serviceName: 'diagnostics-fixture', traceExporter: exporter });
    endSpans();
    await shutdownTelemetry();
    return { mode, exported: exporter.exported };
  }
  initTelemetry({ serviceName: 'diagnostics-fixture' });
  endSpans();
  // The failure is the SDK's to report, through diag; only whether it failed is printed.
  const shutdown = await shutdownTelemetry().then(
    () => 'ok',
    () => 'failed',
  );
  return { mode, shutdown };
}

main().then(
  (outcome) => {
    process.stdout.write(`\n${JSON.stringify(outcome)}\n`);
    process.exit(0);
  },
  (error: unknown) => {
    process.stdout.write(`\n${JSON.stringify({ crashed: everythingOf(error) })}\n`);
    process.exit(1);
  },
);
