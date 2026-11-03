/**
 * The child-process half of `telemetry-boundary.spec.ts` (#385 r6).
 *
 * Runs `initTelemetry` the way a service's main.ts does, under whatever
 * `OTEL_*` environment the spec gave it, and prints one JSON line on stdout
 * saying how it went. Everything else either stream carries is the SDK's, or
 * Node's report of an uncaught throw, which the spec reads whole.
 *
 *   uncaught  `initTelemetry` at the top level, not caught: a refusal is
 *             printed by Node exactly as a service's would be.
 *   twice     a refusal, the state it left (instrumentations, global
 *             providers), a second call, then a third once the variables
 *             named in argv[2] (comma-separated) are removed.
 *   exports   spans, a metric and a log record through whatever exporters the
 *             environment chose, then shutdown, which flushes them all.
 */
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { metrics, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { initTelemetry, shutdownTelemetry } from '../telemetry';

// The logs API is NodeSDK's dependency, not this package's: what is used of it.
interface LogsApi {
  logs: {
    getLogger(name: string): { emit(record: { body: string; severityText: string }): void };
  };
}
const apiLogs = createRequire(require.resolve('@opentelemetry/sdk-node'))(
  '@opentelemetry/api-logs',
) as LogsApi;

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

function refusalOf(start: () => unknown): { name: string; message: string; all: string } | null {
  try {
    start();
    return null;
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : '',
      all: everythingOf(error),
    };
  }
}

/**
 * What a start left behind: whether `module` (`http` or `https`, both patched
 * by the http instrumentation) is patched when first required now, and the
 * globally registered providers. A module is checked once: the require hook
 * keeps what it first returned.
 */
function leftBehind(module: 'http' | 'https'): Record<string, unknown> {
  // `require`, not an import: the instrumentations patch on require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(module) as { request: { __wrapped?: boolean } };
  const delegate = (
    trace.getTracerProvider() as { getDelegate?: () => { constructor: { name: string } } }
  ).getDelegate?.();
  return {
    patched: loaded.request.__wrapped === true,
    meterProvider: metrics.getMeterProvider().constructor.name,
    tracerProvider: delegate?.constructor.name ?? 'none',
  };
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
  const tracer = trace.getTracer('telemetry-boundary-fixture');
  for (let i = 0; i < 2; i += 1) tracer.startSpan(`boundary-span-${i}`).end();
}

const [mode, removeAfter = ''] = process.argv.slice(1);

if (mode === 'uncaught') {
  // At the top level, not caught, as in every service's main.ts: Node prints a
  // refusal itself — message, stack and own properties.
  initTelemetry({ serviceName: 'telemetry-boundary-fixture' });
  process.stdout.write(`\n${JSON.stringify({ mode, started: true })}\n`);
  process.exit(0);
}

async function main(): Promise<Record<string, unknown>> {
  if (mode === 'twice') {
    const first = refusalOf(() => initTelemetry({ serviceName: 'telemetry-boundary-fixture' }));
    const afterFirst = leftBehind('http');
    const second = refusalOf(() => initTelemetry({ serviceName: 'telemetry-boundary-fixture' }));
    for (const name of removeAfter.split(',').filter(Boolean)) delete process.env[name];
    const exporter = new CountingExporter();
    const third = refusalOf(() =>
      initTelemetry({ serviceName: 'telemetry-boundary-fixture', traceExporter: exporter }),
    );
    const afterThird = leftBehind('https');
    endSpans();
    await shutdownTelemetry();
    return { mode, first, afterFirst, second, third, afterThird, exported: exporter.exported };
  }
  if (mode === 'exports') {
    initTelemetry({ serviceName: 'telemetry-boundary-fixture' });
    endSpans();
    metrics.getMeter('telemetry-boundary-fixture').createCounter('boundary_counter').add(1);
    apiLogs.logs
      .getLogger('telemetry-boundary-fixture')
      .emit({ body: 'boundary-log-record', severityText: 'INFO' });
    const shutdown = await shutdownTelemetry().then(
      () => 'ok',
      (error: unknown) => ({ failed: everythingOf(error) }),
    );
    return { mode, shutdown };
  }
  throw new Error(`unknown mode ${mode}`);
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
