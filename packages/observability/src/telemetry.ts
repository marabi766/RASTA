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
  SpanStatusCode,
  type Span,
  type Context,
  type Attributes,
  type SpanKind,
  type Link,
} from '@opentelemetry/api';
import { RedactingSpanProcessor } from './url-redaction';

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

export function initTelemetry(config: TelemetryConfig): NodeSDK | undefined {
  if (config.enabled === false) return undefined;
  if (sdk) return sdk;

  // OpenTelemetry 2.x replaced the `Resource` class with a factory; the
  // attributes it carries are unchanged.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
    'service.namespace': config.namespace ?? 'rasta',
    'deployment.environment': config.environment ?? process.env.NODE_ENV ?? 'development',
  });

  let spanProcessors: SpanProcessor[] | undefined;

  sdk = new NodeSDK({
    resource,
    sampler: new RastaSampler(config.sampleRatio ?? 1),
    // Built when `start()` reads it — after NodeSDK has registered its meter
    // provider, at the point where it would build the same processors itself —
    // and not at all under `OTEL_SDK_DISABLED`, where `start()` reads nothing.
    get spanProcessors(): SpanProcessor[] {
      spanProcessors ??= spanPipeline(config);
      return spanProcessors;
    },
    logRecordProcessors: config.logRecordExporter
      ? [new logs.SimpleLogRecordProcessor({ exporter: config.logRecordExporter })]
      : undefined,
    instrumentations: [
      getNodeAutoInstrumentations({
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
      }),
    ],
  });

  sdk.start();
  return sdk;
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
  const exporter =
    config.traceExporter ??
    (config.otlpEndpoint
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint.replace(/\/$/, '')}/v1/traces` })
      : undefined);
  const exporting = exporter
    ? [createBatchSpanProcessorFromEnv(exporter, selfMetrics)]
    : getSpanProcessorsFromEnv(selfMetrics);
  return exporting.length > 0 ? [new RedactingSpanProcessor(), ...exporting] : [];
}
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
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
