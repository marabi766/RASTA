import { NodeSDK, core, logs } from '@opentelemetry/sdk-node';
// NodeSDK's own builders for the span pipeline it derives from its config and
// the environment. The package has no `exports` map, and `NodeSDK.start()`
// calls exactly these; see `exportingSpanProcessors`.
import { createBatchSpanProcessorFromEnv } from '@opentelemetry/sdk-node/build/src/create-from-env';
import { getSpanProcessorsFromEnv } from '@opentelemetry/sdk-node/build/src/utils';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  SamplingDecision,
  type Sampler,
  type SamplingResult,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  trace,
  metrics,
  context as otelContext,
  propagation,
  SpanStatusCode,
  type Span,
  type Context,
  type Attributes,
  type SpanKind,
  type Link,
} from '@opentelemetry/api';
import { tryReadUrl } from '@rasta/config';
import {
  installSafeDiagnostics,
  telemetryRefusal,
  withoutSdkLogLevel,
  type TelemetryStage,
} from './diagnostics';
import { RedactingSampler, RedactingSpanProcessor } from './url-redaction';

/**
 * OpenTelemetry bootstrap.
 *
 * Must be initialised **before** anything else is imported, because the
 * auto-instrumentations patch modules (http, pg, kafkajs) as they load. A
 * service that requires its database client first will produce no database
 * spans at all — a silent, confusing gap.
 */

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  namespace?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
  /**
   * Fraction of traces sampled, 0..1.
   *
   * Errors and financial operations are always sampled regardless of this
   * value — random sampling on a path that may later be the subject of an
   * audit is the wrong economy. See {@link RastaSampler}.
   */
  sampleRatio?: number;
  /**
   * Where finished spans go, in place of the OTLP exporter at `otlpEndpoint`.
   * Tests pass an in-memory exporter here. Without either, NodeSDK chooses from
   * the environment (`OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_*`).
   */
  traceExporter?: SpanExporter;
  /**
   * Where log records go, in place of NodeSDK's choice from the environment
   * (`OTEL_LOGS_EXPORTER`). Tests pass an in-memory exporter here.
   */
  logRecordExporter?: logs.LogRecordExporter;
}

/** Span attribute marking an operation that must always be traced. */
export const ALWAYS_SAMPLE_ATTRIBUTE = 'rasta.always_sample';

/**
 * Samples a fixed fraction of traffic, but never drops a span explicitly
 * marked as financially or legally significant.
 */
export class RastaSampler implements Sampler {
  private readonly ratioSampler: Sampler;

  constructor(ratio: number) {
    this.ratioSampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(ratio),
    });
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (attributes[ALWAYS_SAMPLE_ATTRIBUTE] === true) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED, attributes };
    }
    return this.ratioSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return 'RastaSampler';
  }
}

let sdk: NodeSDK | undefined;

type Instrumentations = ReturnType<typeof getNodeAutoInstrumentations>;

/**
 * What `initTelemetry` refuses an explicit OTLP endpoint that is not a URL
 * with: the OTLP exporter's own refusal quotes it, credentials included.
 */
export const UNREADABLE_OTLP_ENDPOINT =
  'OTEL_EXPORTER_OTLP_ENDPOINT cannot be read as a URL; its value is not repeated';

/**
 * Why telemetry did not start, or did not stop cleanly: a fixed text naming
 * registered settings only (`telemetryRefusal`). Never the SDK's error, its
 * cause or its stack — an exporter's constructor refuses with the endpoint on
 * `.input` or a header in its message (#385 r6, Codex PR-385 r5 F1).
 */
export class TelemetryRefusedError extends Error {
  override readonly name = 'TelemetryRefusedError';
}

/** What a failed {@link shutdownTelemetry} rejects with, in place of the SDK's error. */
export const TELEMETRY_SHUTDOWN_FAILED =
  "OpenTelemetry did not shut down cleanly; the SDK's own error is withheld, it may repeat " +
  'configured values';

/**
 * Builds and starts the SDK once per process; later calls return the same SDK.
 *
 * Everything of the SDK that reads configuration runs inside one boundary —
 * the auto-instrumentations, the `NodeSDK` constructor (which builds the
 * metric readers and their exporters, even under `OTEL_SDK_DISABLED`), and
 * `start()` (which builds the span and log exporters and their processors:
 * OTLP over http/json, http/protobuf or gRPC, Zipkin, console; gRPC metadata
 * from `*_HEADERS`). Whatever any of them throws is discarded and replaced by
 * a fresh {@link TelemetryRefusedError} naming the stage's registered
 * settings. What the SDK reports instead of throwing — during start, an
 * export, a shutdown — goes to `diag`, whose only logger is the safe one
 * (diagnostics.ts).
 *
 * A refused start leaves nothing behind: the instrumentations are disabled,
 * whatever the SDK registered globally is unregistered and its providers are
 * shut down, and no SDK is kept — so a later call builds afresh (and refuses
 * again under the same configuration) rather than returning a half-built one.
 */
export function initTelemetry(config: TelemetryConfig): NodeSDK | undefined {
  if (config.enabled === false) return undefined;
  if (sdk) return sdk;

  // Before anything of the SDK runs — `getNodeAutoInstrumentations` below reads
  // its own variables, and the constructor reads the rest, `OTEL_SDK_DISABLED`
  // first: whatever they report goes through the safe logger (diagnostics.ts).
  const reinstallDiagnostics = installSafeDiagnostics();
  if (config.otlpEndpoint !== undefined && tryReadUrl(config.otlpEndpoint) === null) {
    throw new TelemetryRefusedError(UNREADABLE_OTLP_ENDPOINT);
  }

  // OpenTelemetry 2.x replaced the `Resource` class with a factory; the
  // attributes it carries are unchanged.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
    'service.namespace': config.namespace ?? 'rasta',
    'deployment.environment': config.environment ?? process.env.NODE_ENV ?? 'development',
  });

  let spanProcessors: SpanProcessor[] | undefined;
  // Which part of the SDK is being built, for the refusal's names.
  let stage: TelemetryStage = 'instrumentations';
  let instrumentations: Instrumentations = [];
  let built: NodeSDK | undefined;
  let started = false;
  let refused = false;
  try {
    instrumentations = getNodeAutoInstrumentations({
      // Filesystem spans are enormous in volume and near-useless for
      // diagnosing a distributed system.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // Health and metrics endpoints are polled constantly; tracing them
        // buries the requests that matter.
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/health') || url.startsWith('/metrics');
        },
      },
    });
    // The constructor builds the metric readers from the environment.
    stage = 'metrics';
    // With OTEL_LOG_LEVEL hidden, so the constructor installs no console logger
    // of its own over the safe one.
    built = withoutSdkLogLevel(
      () =>
        new NodeSDK({
          resource,
          // Sanitizes what a span is started with before the SDK cuts it; the
          // redacting span processor below takes everything written after.
          sampler: new RedactingSampler(new RastaSampler(config.sampleRatio ?? 1)),
          // Built when `start()` reads it — after NodeSDK has registered its meter
          // provider, at the point where it would build the same processors itself —
          // and not at all under `OTEL_SDK_DISABLED`, where `start()` reads nothing.
          // Read last before the log exporters, which `start()` builds next.
          get spanProcessors(): SpanProcessor[] {
            stage = 'traces';
            spanProcessors ??= spanPipeline(config);
            stage = 'logs';
            return spanProcessors;
          },
          logRecordProcessors: config.logRecordExporter
            ? [new logs.SimpleLogRecordProcessor({ exporter: config.logRecordExporter })]
            : undefined,
          instrumentations: [instrumentations],
        }),
    );
    // Again, after construction and after start, should anything have replaced it.
    reinstallDiagnostics();
    stage = 'sdk';
    started = true;
    built.start();
    reinstallDiagnostics();
  } catch {
    // Nothing of the error is kept: not its message, cause, stack or properties.
    refused = true;
  }
  if (refused) {
    discardPartialStart(built, instrumentations, started);
    reinstallDiagnostics();
    throw new TelemetryRefusedError(telemetryRefusal(stage, process.env));
  }
  sdk = built;
  return sdk;
}

/**
 * Undoes what a refused start did: disables the instrumentations (they patch
 * modules as they are built), unregisters what `start()` registers globally —
 * the context manager, the propagator, and the meter and tracer providers
 * (the logger provider is registered last, so a refused start never reached
 * it) — and shuts the built SDK's providers down. The shutdown is not awaited;
 * whatever it reports goes to `diag`, and a rejection is dropped.
 */
function discardPartialStart(
  built: NodeSDK | undefined,
  instrumentations: Instrumentations,
  started: boolean,
): void {
  for (const instrumentation of instrumentations) {
    try {
      instrumentation.disable();
    } catch {
      // Best effort; its error is not reported, for the same reason.
    }
  }
  if (started) {
    trace.disable();
    metrics.disable();
    otelContext.disable();
    propagation.disable();
  }
  built?.shutdown().catch(() => undefined);
}

/**
 * The span pipeline: the redacting processor, then the exporting ones.
 *
 * The exporting processors are exactly the ones `NodeSDK.start()` would build
 * itself from `traceExporter: <the OTLP exporter at otlpEndpoint, if any>`,
 * through the same two functions with the same arguments — a batch processor
 * tuned by `OTEL_BSP_*` around an explicit exporter, and otherwise the
 * environment's choice: `OTEL_TRACES_EXPORTER` (`otlp`, `console`, `zipkin`, a
 * list) and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`. Building them here only lets
 * the redacting processor stand in front of them; which exporter runs, and
 * how, is unchanged (Codex on #261, F3; `exporter-selection.spec.ts`).
 *
 * The redacting processor sanitizes what a span is given as it is given, so
 * every exporting processor only ever sees — and exports — the sanitized span. With no
 * exporting processor (`OTEL_TRACES_EXPORTER=none`) the pipeline is empty, and
 * NodeSDK then registers no tracer provider, as it did before.
 */
function spanPipeline(config: TelemetryConfig): SpanProcessor[] {
  // NodeSDK's SDK self-metrics meter: its own provider, which `start()` has
  // registered globally by now, when the opt-in variable is set.
  const selfMetrics = core.getBooleanFromEnv('OTEL_NODE_EXPERIMENTAL_SDK_METRICS')
    ? metrics.getMeterProvider()
    : undefined;
  const exporter = config.traceExporter ?? otlpTraceExporter(config.otlpEndpoint);
  const exporting = exporter
    ? [createBatchSpanProcessorFromEnv(exporter, selfMetrics)]
    : getSpanProcessorsFromEnv(selfMetrics);
  return exporting.length > 0 ? [new RedactingSpanProcessor(), ...exporting] : [];
}

/**
 * The OTLP exporter at `otlpEndpoint`, or undefined without one. Built inside
 * `initTelemetry`'s boundary: its own refusal, which quotes the URL, is replaced.
 */
function otlpTraceExporter(otlpEndpoint: string | undefined): SpanExporter | undefined {
  if (!otlpEndpoint) return undefined;
  return new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` });
}

/**
 * Flushes and stops the SDK. Rejects, when the SDK's shutdown does, with a
 * fresh {@link TelemetryRefusedError} ({@link TELEMETRY_SHUTDOWN_FAILED}): the
 * SDK's own rejection — an exporter's, quoting its endpoint or a collector's
 * answer — is dropped, since the caller logs what it is given.
 */
export async function shutdownTelemetry(): Promise<void> {
  const current = sdk;
  if (!current) return;
  sdk = undefined;
  let failed = false;
  await current.shutdown().catch(() => {
    failed = true;
  });
  if (failed) throw new TelemetryRefusedError(TELEMETRY_SHUTDOWN_FAILED);
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a span, recording the exception and setting an error status
 * if it throws. Rethrows either way — tracing never changes control flow.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: { attributes?: Attributes; alwaysSample?: boolean },
): Promise<T> {
  const tracer = trace.getTracer('rasta');
  const attributes: Attributes = {
    ...options?.attributes,
    ...(options?.alwaysSample ? { [ALWAYS_SAMPLE_ATTRIBUTE]: true } : {}),
  };

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs `fn` inside a span that is always sampled.
 *
 * Use for anything that moves money or advances a tender: those are the traces
 * an auditor will ask for, and they must exist.
 */
export function withFinancialSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return withSpan(name, fn, { attributes, alwaysSample: true });
}

/** The active trace and span ids, for stitching logs to traces. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(otelContext.active());
  if (!span) return {};
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export function addSpanAttributes(attributes: Attributes): void {
  trace.getSpan(otelContext.active())?.setAttributes(attributes);
}
