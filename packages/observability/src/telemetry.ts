import { NodeSDK, core, logs, metrics as sdkMetrics } from '@opentelemetry/sdk-node';
// NodeSDK's own builders for the pipelines it derives from its config and the
// environment. The package has no `exports` map; `NodeSDK` calls exactly these
// (see `spanPipeline` and `metricReadersFromEnv`).
import { createBatchSpanProcessorFromEnv } from '@opentelemetry/sdk-node/build/src/create-from-env';
import {
  getOtlpMetricExporterFromEnv,
  getPeriodicExportingMetricReaderFromEnv,
  getSpanProcessorsFromEnv,
} from '@opentelemetry/sdk-node/build/src/utils';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { logs as logsApi } from '@opentelemetry/api-logs';
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
  diag,
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
/** What the running SDK owns: {@link shutdownTelemetry} releases all of it. */
let owned: Construction | undefined;
/** True while `initTelemetry` builds: a call made from inside it is refused. */
let building = false;
/**
 * The teardown in progress — a shutdown's, or a refused start's releases —
 * until every part of it has settled (see {@link fence}): no SDK may start
 * before. Never rejects unhandled.
 */
let stopping: Promise<void> | undefined;

type Instrumentations = ReturnType<typeof getNodeAutoInstrumentations>;

/**
 * What `initTelemetry` refuses an explicit OTLP endpoint that is not a URL
 * with: the OTLP exporter's own refusal quotes it, credentials included.
 */
export const UNREADABLE_OTLP_ENDPOINT =
  'OTEL_EXPORTER_OTLP_ENDPOINT cannot be read as a URL; its value is not repeated';

/** What `initTelemetry` refuses a call made while it is still building the SDK with. */
export const TELEMETRY_ALREADY_STARTING =
  'initTelemetry was called while it was already building the SDK; the inner call is refused';

/** What `initTelemetry` refuses a call made before a pending shutdown settled with. */
export const TELEMETRY_STILL_STOPPING =
  'initTelemetry was called while shutdownTelemetry was still stopping the SDK; await it first';

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
 * What a start builds or is handed — the ownership ledger, kept so that a
 * refusal, and later {@link shutdownTelemetry}, can release all of it and a
 * commit can start what holds a resource (#426 r1 F3, #749 r2).
 *
 * Built inert, committed last: every part that would hold a process resource
 * (the Prometheus listener, a periodic reader's export timer) is built with
 * that resource deferred, and `activations` starts them only once nothing of
 * the start can throw any more. So a refusal is reported with nothing of
 * this start listening or scheduled, and `releases` shuts down every exporter
 * it was handed or built — flushing nothing, since nothing was recorded yet; until those have settled
 * they are the restart {@link fence}. What the SDK's own builders make and lose when one of them
 * throws part-way (an exporter `getSpanProcessorsFromEnv` built before the
 * next one refused) holds nothing until its first export, which never comes:
 * `telemetry-ownership.spec.ts` proves the process holds exactly what it held
 * before, for every exporter kind built ahead of a refusing one.
 */
interface Construction {
  /** Disabled on refusal and on shutdown: they patch modules as they are built. */
  instrumentations: Instrumentations;
  /**
   * Released on refusal, without a flush, and last on shutdown — whether or
   * not what flushes into them failed: every exporter handed in or built (the
   * Prometheus reader too), the SDK-built processors' exporters too
   * ({@link ownProcessor}). Adopted as each part exists.
   */
  readonly releases: Release[];
  /**
   * Released on shutdown only, before `releases`: what flushes into an
   * exporter — a registered periodic reader, every span and log record
   * processor. On refusal they hold nothing (a reader's timer is deferred, no
   * span or record was taken) and a flush would export.
   */
  readonly pipelines: Release[];
  /** Run at commit, in order: start what holds a resource. */
  readonly activations: (() => void)[];
}

/** One owned part's shutdown, made idempotent by {@link own}: it never throws. */
type Release = () => Promise<unknown>;

/** Whether `part`'s shutdown is already one of `construction`'s releases or pipelines. */
function isOwned(construction: Construction, part: { shutdown: unknown }): boolean {
  const shutdown = part.shutdown as Release;
  return construction.releases.includes(shutdown) || construction.pipelines.includes(shutdown);
}

/**
 * Owns a processor the SDK built around an exporter — the environment's span
 * processors, the log record processors — and, independently, that exporter
 * (#749 r3 F2): a batch processor's shutdown awaits its final flush and only
 * then shuts its exporter down, so a failed export skips the exporter's
 * shutdown, and with it the wait for the exports still in flight. Here the
 * processor flushes in `pipelines` and its exporter is shut down in
 * `releases` whether or not that flush failed; a processor that did shut it
 * down shares the one call ({@link own}).
 *
 * The exporter is the processor's `_exporter` (sdk-trace's and sdk-logs'
 * batch and simple processors; `telemetry-ownership.spec.ts` fails should it
 * move). A processor without one is released whole, and `false` is returned:
 * the start is refused — an exporter that cannot be owned is not run.
 */
function ownProcessor(
  construction: Construction,
  processor: SpanProcessor | logs.LogRecordProcessor,
): boolean {
  if (isOwned(construction, processor)) return true;
  const exporter = (processor as unknown as { _exporter?: { shutdown(): Promise<unknown> } })
    ._exporter;
  if (typeof exporter?.shutdown !== 'function') {
    own(construction.releases, processor);
    return false;
  }
  own(construction.pipelines, processor);
  if (!isOwned(construction, exporter)) own(construction.releases, exporter);
  return true;
}

/**
 * Owns `part`, built here or by the SDK: its `shutdown` becomes idempotent —
 * the SDK's own call (a provider shutting down its processors and readers) and
 * the fence's share one promise, so the fence waits for the very closure the
 * SDK started — and is kept in `into`. A shutdown that throws becomes a rejection.
 */
function own(into: Release[], part: { shutdown(): Promise<unknown> }): void {
  const once = releaseOnce(part.shutdown.bind(part));
  part.shutdown = once;
  into.push(once);
}

/**
 * Owns `part`, handed in by the caller, as {@link own} does — but through a
 * plain stand-in given to the SDK in its place, so the caller's object (frozen,
 * perhaps) is untouched. The SDK calls an exporter's `export`, `shutdown` and,
 * where it has one, `forceFlush`; nothing else.
 */
function ownHandedIn<T extends SpanExporter | logs.LogRecordExporter>(into: Release[], part: T): T {
  const once = releaseOnce(() => part.shutdown());
  into.push(once);
  const standIn: Record<string, unknown> = {
    export: (...args: unknown[]) => Reflect.apply(part.export, part, args) as unknown,
    shutdown: once,
  };
  const flush = part.forceFlush;
  if (typeof flush === 'function') standIn.forceFlush = () => Reflect.apply(flush, part, []);
  return standIn as unknown as T;
}

function releaseOnce(shutdown: () => unknown): Release {
  let settling: Promise<unknown> | undefined;
  return () => (settling ??= invoke(shutdown));
}

function invoke(call: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Runs each tier of releases once the previous tier has settled — every
 * member, not the first to fail (`NodeSDK.shutdown()` and each provider's are
 * fail-fast `Promise.all`s: their rejection does not mean the rest finished).
 * Resolves whether every one succeeded; never rejects.
 */
async function settleAll(tiers: readonly (readonly Release[])[]): Promise<boolean> {
  let clean = true;
  for (const tier of tiers) {
    const outcomes = await Promise.allSettled(tier.map((release) => release()));
    if (outcomes.some((outcome) => outcome.status === 'rejected')) clean = false;
  }
  return clean;
}

/**
 * Runs `teardown` behind the restart fence: `initTelemetry` refuses until it
 * has settled, and {@link shutdownTelemetry} returns it — rejecting with
 * {@link TELEMETRY_SHUTDOWN_FAILED}, nothing of the parts' errors, when one
 * failed or `teardown` threw. A refused start's fence has no caller, so its
 * rejection is handled.
 *
 * The fence is published before `teardown` is called (#749 r3 F1): what it
 * calls — a caller's exporter, synchronously from the SDK's own shutdown —
 * may call back in, and must find a restart refused and a nested shutdown
 * answered with this very promise, not a settled one.
 */
function fence(teardown: () => Promise<boolean>): Promise<void> {
  let run!: (work: Promise<boolean>) => void;
  const outcome = new Promise<boolean>((resolve) => (run = resolve));
  const pending: Promise<void> = outcome
    .then(
      (clean) => {
        if (!clean) throw new TelemetryRefusedError(TELEMETRY_SHUTDOWN_FAILED);
      },
      () => {
        throw new TelemetryRefusedError(TELEMETRY_SHUTDOWN_FAILED);
      },
    )
    .finally(() => {
      if (stopping === pending) stopping = undefined;
    });
  pending.catch(() => undefined);
  stopping = pending;
  run(invoke(teardown) as Promise<boolean>);
  return pending;
}

/**
 * Builds and starts the SDK once per process; later calls return the same SDK.
 *
 * Synchronous on purpose: every service's main.ts and its `pnpm dev` preload
 * call it before the application graph is imported, and the instrumentations
 * it installs patch modules as they load.
 *
 * Everything of the SDK that reads configuration runs inside one boundary —
 * the auto-instrumentations, the metric readers and their exporters (built
 * here, as the `NodeSDK` constructor would build them, even under
 * `OTEL_SDK_DISABLED`), the `NodeSDK` constructor, and `start()` (which builds
 * the span and log exporters and their processors: OTLP over http/json,
 * http/protobuf or gRPC, Zipkin, console; gRPC metadata from `*_HEADERS`).
 * Whatever any of them throws is discarded and replaced by a fresh
 * {@link TelemetryRefusedError} naming the stage's registered settings. What
 * the SDK reports instead of throwing — during start, an export, a shutdown —
 * goes to `diag`, whose only logger is the safe one (diagnostics.ts).
 *
 * A refused start leaves nothing behind (see {@link Construction}): the
 * instrumentations are disabled, whatever the SDK registered globally is
 * unregistered, nothing of it is listening or scheduled, every exporter is
 * being shut down, and no SDK is kept — so a later call builds afresh (and
 * refuses again under the same configuration) rather than returning a
 * half-built one, and finds the Prometheus port free, once the refusal's
 * releases have settled. A call made while one
 * is building, or before a teardown — {@link shutdownTelemetry}'s, or a
 * refused start's releases — has settled, is refused: await
 * `shutdownTelemetry()` first.
 */
export function initTelemetry(config: TelemetryConfig): NodeSDK | undefined {
  if (config.enabled === false) return undefined;
  if (sdk) return sdk;
  if (building) throw new TelemetryRefusedError(TELEMETRY_ALREADY_STARTING);
  if (stopping) throw new TelemetryRefusedError(TELEMETRY_STILL_STOPPING);
  building = true;
  try {
    return buildAndStart(config);
  } finally {
    building = false;
  }
}

function buildAndStart(config: TelemetryConfig): NodeSDK {
  // Before anything of the SDK runs — `getNodeAutoInstrumentations` below reads
  // its own variables, and the constructor reads the rest, `OTEL_SDK_DISABLED`
  // first: whatever they report goes through the safe logger (diagnostics.ts).
  const reinstallDiagnostics = installSafeDiagnostics();
  const construction: Construction = {
    instrumentations: [],
    releases: [],
    pipelines: [],
    activations: [],
  };
  // Owned before anything can refuse: a refusal releases what it was handed.
  const traceExporter =
    config.traceExporter && ownHandedIn(construction.releases, config.traceExporter);
  const logExporter =
    config.logRecordExporter && ownHandedIn(construction.releases, config.logRecordExporter);
  if (config.otlpEndpoint !== undefined && tryReadUrl(config.otlpEndpoint) === null) {
    discardPartialStart(construction, false);
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
  let registering = false;
  let built: NodeSDK | undefined;
  try {
    construction.instrumentations = getNodeAutoInstrumentations({
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
    stage = 'metrics';
    // With OTEL_LOG_LEVEL hidden, so the constructor installs no console logger
    // of its own over the safe one.
    built = withoutSdkLogLevel(() => {
      const metricReaders = metricReadersFromEnv(construction);
      return new NodeSDK({
        resource,
        // Sanitizes what a span is started with before the SDK cuts it; the
        // redacting span processor below takes everything written after.
        sampler: new RedactingSampler(new RastaSampler(config.sampleRatio ?? 1)),
        metricReaders,
        // Built when `start()` reads it — after NodeSDK has registered its meter
        // provider, at the point where it would build the same processors itself —
        // and not at all under `OTEL_SDK_DISABLED`, where `start()` reads nothing.
        // Read last before the log exporters, which `start()` builds next.
        get spanProcessors(): SpanProcessor[] {
          stage = 'traces';
          spanProcessors ??= spanPipeline(config, traceExporter, construction);
          stage = 'logs';
          return spanProcessors;
        },
        logRecordProcessors: logExporter
          ? [new logs.SimpleLogRecordProcessor({ exporter: logExporter })]
          : undefined,
        instrumentations: [construction.instrumentations],
      });
    });
    // Again, after construction and after start, should anything have replaced it.
    reinstallDiagnostics();
    stage = 'sdk';
    registering = true;
    built.start();
    // A log exporter that cannot be owned refuses the start (`ownProcessor`).
    if (!ownLogRecordProcessors(built, construction)) throw new Error('unowned log exporter');
    reinstallDiagnostics();
  } catch {
    // Nothing of the error is kept: not its message, cause, stack or properties.
    if (built) ownLogRecordProcessors(built, construction);
    discardPartialStart(construction, registering);
    reinstallDiagnostics();
    throw new TelemetryRefusedError(telemetryRefusal(stage, process.env));
  }
  // The commit: nothing below throws. Only now does anything listen or tick.
  for (const activate of construction.activations) {
    try {
      activate();
    } catch {
      diag.error(READER_NOT_STARTED);
    }
  }
  sdk = built;
  owned = construction;
  return built;
}

/**
 * Owns the log record processors `start()` gave its logger provider, and each
 * one's exporter ({@link ownProcessor}): the caller's, or the ones NodeSDK
 * built from `OTEL_LOGS_EXPORTER` itself (`configureLoggerProviderFromEnv`,
 * which it does not export, keeps them here). `telemetry-ownership.spec.ts`
 * fails should the field move. False when an exporter could not be owned.
 */
function ownLogRecordProcessors(built: NodeSDK, construction: Construction): boolean {
  const config = (
    built as unknown as {
      _loggerProviderConfig?: { logRecordProcessors?: logs.LogRecordProcessor[] };
    }
  )._loggerProviderConfig;
  let owning = true;
  for (const processor of config?.logRecordProcessors ?? []) {
    if (!ownProcessor(construction, processor)) owning = false;
  }
  return owning;
}

/** What `diag` is told when a committed reader cannot start; nothing of its error. */
const READER_NOT_STARTED =
  'A metric reader could not start (OTEL_METRICS_EXPORTER, OTEL_EXPORTER_PROMETHEUS_HOST, ' +
  'OTEL_EXPORTER_PROMETHEUS_PORT); its error is withheld';

/**
 * Undoes what a refused start did: disables the instrumentations, unregisters
 * what `start()` registers globally — the context manager, the propagator, and
 * the meter and tracer providers (the logger provider is registered last, so a
 * refused start never reached it) — and starts every release. Nothing of this
 * start listens or is scheduled (see {@link Construction}), so the refusal is
 * thrown at once; but a release may still be settling, so they are the
 * restart {@link fence}: a retry is refused until each has settled, and
 * `shutdownTelemetry()` waits for them and reports whether one failed.
 */
function discardPartialStart(construction: Construction, registering: boolean): void {
  // Published first: a release may call back in (r3 F1).
  fence(() => {
    disableAll(construction.instrumentations);
    if (registering) unregisterGlobals();
    return settleAll([construction.releases]);
  });
}

function disableAll(instrumentations: Instrumentations): void {
  for (const instrumentation of instrumentations) {
    try {
      instrumentation.disable();
    } catch {
      // Best effort; its error is not reported, for the same reason.
    }
  }
}

/** Unregisters everything `NodeSDK.start()` registers with the API. */
function unregisterGlobals(): void {
  trace.disable();
  metrics.disable();
  logsApi.disable();
  otelContext.disable();
  propagation.disable();
}

/**
 * The metric readers the `NodeSDK` constructor would build from
 * `OTEL_METRICS_EXPORTER` — the same kinds, order and settings, through the
 * same builders (`getMetricReadersFromEnv` in sdk-node's sdk.js, which it does
 * not export; `telemetry-ownership.spec.ts` compares the two) — but inert: the
 * Prometheus exporter does not listen and a periodic reader does not schedule
 * its export when the meter provider registers them. Both are deferred to
 * the commit, and only for a reader the SDK did register: under
 * `OTEL_SDK_DISABLED` nothing is.
 */
function metricReadersFromEnv(construction: Construction): sdkMetrics.MetricReader[] {
  const readers: sdkMetrics.MetricReader[] = [];
  const enabled = Array.from(new Set(core.getStringListFromEnv('OTEL_METRICS_EXPORTER') ?? []));
  if (enabled.length === 0) {
    diag.debug('OTEL_METRICS_EXPORTER is empty. Using default otlp exporter.');
    enabled.push('otlp');
  }
  if (enabled.includes('none')) {
    diag.info('OTEL_METRICS_EXPORTER contains "none". Metric provider will not be initialized.');
    return readers;
  }
  const periodic = (exporter: sdkMetrics.PushMetricExporter, reader: () => unknown): void => {
    own(construction.releases, exporter);
    const built = reader() as sdkMetrics.MetricReader;
    readers.push(deferInitialization(built, construction, () => undefined, true));
  };
  for (const name of enabled) {
    if (name === 'otlp') {
      const exporter = getOtlpMetricExporterFromEnv();
      periodic(exporter, () => getPeriodicExportingMetricReaderFromEnv(exporter));
    } else if (name === 'console') {
      const exporter = new sdkMetrics.ConsoleMetricExporter();
      periodic(exporter, () => new sdkMetrics.PeriodicExportingMetricReader({ exporter }));
    } else if (name === 'prometheus') {
      const exporter = new PrometheusExporter({ preventServerStart: true });
      own(construction.releases, exporter);
      readers.push(
        deferInitialization(exporter, construction, () => {
          // A refused listen (the port taken) is reported, as NodeSDK's own
          // exporter reports it — but with nothing of its error.
          exporter.startServer().catch(() => {
            diag.error(READER_NOT_STARTED);
          });
        }),
      );
    } else {
      diag.warn(
        `Unsupported OTEL_METRICS_EXPORTER value: "${name}". Supported values are: otlp, console, prometheus, none.`,
      );
    }
  }
  return readers;
}

/**
 * `reader`, with what the meter provider calls when it registers it —
 * `onInitialized`, where a periodic reader starts its export timer — deferred
 * to the commit, followed there by `thenStart` (the Prometheus listener).
 * A `periodic` reader, once registered, is owned: shutdown flushes it.
 */
function deferInitialization<T extends sdkMetrics.MetricReader>(
  reader: T,
  construction: Construction,
  thenStart: () => void,
  periodic = false,
): T {
  const hook = reader as unknown as { onInitialized(): void };
  const initialize = hook.onInitialized.bind(reader);
  hook.onInitialized = () => {
    if (periodic) own(construction.pipelines, reader);
    construction.activations.push(() => {
      initialize();
      thenStart();
    });
  };
  return reader;
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
 *
 * Each exporter is released on refusal as soon as it exists, and on shutdown
 * whether or not its processor's final flush failed: an explicit one itself,
 * the environment's through {@link ownProcessor}.
 */
function spanPipeline(
  config: TelemetryConfig,
  traceExporter: SpanExporter | undefined,
  construction: Construction,
): SpanProcessor[] {
  // NodeSDK's SDK self-metrics meter: its own provider, which `start()` has
  // registered globally by now, when the opt-in variable is set.
  const selfMetrics = core.getBooleanFromEnv('OTEL_NODE_EXPERIMENTAL_SDK_METRICS')
    ? metrics.getMeterProvider()
    : undefined;
  // An explicit exporter is owned already; the OTLP one is as soon as it exists.
  const otlp = traceExporter ? undefined : otlpTraceExporter(config.otlpEndpoint);
  if (otlp) own(construction.releases, otlp);
  const exporter = traceExporter ?? otlp;
  let exporting: SpanProcessor[];
  if (exporter) {
    const batch = createBatchSpanProcessorFromEnv(exporter, selfMetrics);
    own(construction.pipelines, batch);
    exporting = [batch];
  } else {
    exporting = getSpanProcessorsFromEnv(selfMetrics);
    // Every one owned before a refusal: an exporter that cannot be is not run.
    const owning = exporting.map((processor) => ownProcessor(construction, processor));
    if (owning.includes(false)) throw new Error('unowned span exporter');
  }
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
 * Disables the instrumentations, flushes and stops the SDK, then shuts down
 * every part it owns — each one the SDK's own shutdown reached or did not
 * (a registered reader, a processor, then every exporter) — and only when all
 * of them have settled unregisters it from the API, so that a later
 * {@link initTelemetry} starts a new one that is really used. Concurrent calls
 * share one outcome, and until it settles `initTelemetry` refuses (the
 * {@link fence}). After a refused start it returns that start's fence.
 *
 * Rejects, when any part failed, with a fresh {@link TelemetryRefusedError}
 * ({@link TELEMETRY_SHUTDOWN_FAILED}) — after every part has settled: the
 * parts' own rejections — an exporter's, quoting its endpoint or a
 * collector's answer — are dropped, since the caller logs what it is given.
 */
export function shutdownTelemetry(): Promise<void> {
  if (stopping) return stopping;
  const current = sdk;
  const parts = owned;
  if (!current || !parts) return Promise.resolve();
  sdk = undefined;
  owned = undefined;
  // Published before anything of the SDK is called: it calls the caller's
  // exporters, which may call back in (r3 F1).
  return fence(async () => {
    disableAll(parts.instrumentations);
    const clean = await settleAll([
      [() => invoke(() => current.shutdown())],
      parts.pipelines,
      parts.releases,
    ]);
    unregisterGlobals();
    return clean;
  });
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
