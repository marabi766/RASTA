import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';

/**
 * What the OpenTelemetry SDK's own diagnostics may print (#385 r5).
 *
 * The SDK reads every `OTEL_*` variable it inherits — whether or not
 * `OTEL_SDK_DISABLED` is set — and reports what it could not use on `diag`,
 * quoting the value: an endpoint with its password, a compression, an
 * interval, a detector list (Codex PR-385 r4 F1). With `OTEL_LOG_LEVEL` set,
 * the `NodeSDK` constructor installs a console logger that prints those
 * messages as they are, replacing any logger installed before it.
 *
 * So `initTelemetry` owns the channel instead: {@link SafeDiagLogger} is
 * installed before anything of the SDK runs, at the level `OTEL_LOG_LEVEL`
 * asks for (none when unset — the SDK's own default), the variable is hidden
 * while the SDK constructs so it never installs its own, and the safe logger
 * is installed again after construction and after start. It prints, per
 * diagnostic, a level, an audited category and the registered setting names
 * the message mentions — never the message, its arguments or an error.
 *
 * Not chosen: validating every `OTEL_*` variable and stripping the bad ones
 * before the SDK reads them. That re-implements the SDK's parser for each of
 * ~80 settings and goes stale on every upgrade; it changes what a valid but
 * unusual configuration does; and it covers neither the diagnostics written
 * after start (an export failure quoting a collector's answer) nor a value the
 * SDK reads that the table missed. Owning the channel covers every message,
 * whatever produced it.
 */

/** The signals with their own `OTEL_EXPORTER_OTLP_<SIGNAL>_*` settings. */
const OTLP_SIGNALS = ['TRACES', 'METRICS', 'LOGS'] as const;

/** The `OTEL_EXPORTER_OTLP_*` settings each signal also has its own copy of. */
const OTLP_SETTINGS = [
  'CERTIFICATE',
  'CLIENT_CERTIFICATE',
  'CLIENT_KEY',
  'COMPRESSION',
  'ENDPOINT',
  'HEADERS',
  'INSECURE',
  'PROTOCOL',
  'TIMEOUT',
] as const;

/**
 * Every `OTEL_*` setting the installed SDK packages read, by name — the only
 * names a diagnostic is printed with. `diagnostics.spec.ts` fails when an
 * installed package reads a setting missing here, so an upgrade that adds one
 * is audited before its name can be printed.
 */
export const OTEL_SETTINGS: ReadonlySet<string> = new Set([
  ...OTLP_SETTINGS.map((setting) => `OTEL_EXPORTER_OTLP_${setting}`),
  ...OTLP_SIGNALS.flatMap((signal) =>
    OTLP_SETTINGS.map((setting) => `OTEL_EXPORTER_OTLP_${signal}_${setting}`),
  ),
  'OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION',
  'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  'OTEL_ATTRIBUTE_COUNT_LIMIT',
  'OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT',
  'OTEL_BLRP_EXPORT_TIMEOUT',
  'OTEL_BLRP_MAX_EXPORT_BATCH_SIZE',
  'OTEL_BLRP_MAX_QUEUE_SIZE',
  'OTEL_BLRP_SCHEDULE_DELAY',
  'OTEL_BSP_EXPORT_TIMEOUT',
  'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
  'OTEL_BSP_MAX_QUEUE_SIZE',
  'OTEL_BSP_SCHEDULE_DELAY',
  'OTEL_CONFIG_FILE',
  'OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT',
  'OTEL_EXPORTER_PROMETHEUS_HOST',
  'OTEL_EXPORTER_PROMETHEUS_PORT',
  'OTEL_EXPORTER_ZIPKIN_ENDPOINT',
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
  'OTEL_LINK_ATTRIBUTE_COUNT_LIMIT',
  'OTEL_LOG_LEVEL',
  'OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT',
  'OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRIC_EXPORT_TIMEOUT',
  'OTEL_METRICS_EXEMPLAR_FILTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_NODE_DISABLED_INSTRUMENTATIONS',
  'OTEL_NODE_ENABLED_INSTRUMENTATIONS',
  'OTEL_NODE_EXPERIMENTAL_SDK_METRICS',
  'OTEL_NODE_RESOURCE_DETECTORS',
  'OTEL_PROPAGATORS',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SDK_DISABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT',
  'OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT',
  'OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT',
  'OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT',
  'OTEL_SPAN_EVENT_COUNT_LIMIT',
  'OTEL_SPAN_LINK_COUNT_LIMIT',
  'OTEL_TRACES_EXPORTER',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
]);

/**
 * The categories a diagnostic is printed under, first match wins: tested
 * against the SDK's message, never printed from it.
 */
const CATEGORIES: readonly (readonly [category: string, test: RegExp])[] = [
  ['configuration', /OTEL_[A-Z0-9_]+|configuration|environment/i],
  ['export', /export|collector/i],
  ['instrumentation', /instrumentation|patch|hook/i],
  ['resource', /resource|detector/i],
  ['propagation', /propagat/i],
];

/** `DiagLogLevel` by `OTEL_LOG_LEVEL` value, as the SDK reads it (upper-cased, untrimmed). */
const LOG_LEVELS: Readonly<Record<string, DiagLogLevel>> = Object.freeze({
  NONE: DiagLogLevel.NONE,
  ERROR: DiagLogLevel.ERROR,
  WARN: DiagLogLevel.WARN,
  INFO: DiagLogLevel.INFO,
  DEBUG: DiagLogLevel.DEBUG,
  VERBOSE: DiagLogLevel.VERBOSE,
  ALL: DiagLogLevel.ALL,
});

/** What an `OTEL_LOG_LEVEL` that is not a level is reported with: never the value. */
export const UNKNOWN_LOG_LEVEL =
  'OTEL_LOG_LEVEL is not one of NONE, ERROR, WARN, INFO, DEBUG, VERBOSE, ALL; INFO is used ' +
  '(its value is not repeated)';

/**
 * The level `OTEL_LOG_LEVEL` asks for: `null` when unset or blank (the SDK
 * then installs no logger), `'unknown'` when not a level (the SDK then uses
 * INFO, after quoting the value).
 */
export function requestedLogLevel(raw: string | undefined): DiagLogLevel | 'unknown' | null {
  if (raw === undefined || raw.trim() === '') return null;
  const upper = raw.toUpperCase();
  return Object.hasOwn(LOG_LEVELS, upper) ? LOG_LEVELS[upper] : 'unknown';
}

/**
 * One printed line per diagnostic: the level, the category, the registered
 * names. `args` is what the SDK logged — a component logger puts its namespace
 * first — and is only tested, never printed.
 */
export function describeDiagnostic(level: string, args: readonly unknown[]): string {
  const text = args.filter((arg): arg is string => typeof arg === 'string').join(' ');
  const category = CATEGORIES.find(([, test]) => test.test(text))?.[0] ?? 'sdk';
  const names = [...new Set(text.match(/OTEL_[A-Z0-9_]+/g) ?? [])]
    .filter((name) => OTEL_SETTINGS.has(name))
    .sort();
  return (
    `[telemetry] ${level} ${category}${names.length > 0 ? ` (${names.join(', ')})` : ''}: ` +
    "the OpenTelemetry SDK's own text is withheld; it may repeat configuration values"
  );
}

/** Where the safe logger writes: one line on stderr. */
export type DiagnosticWriter = (line: string) => void;

const toStderr: DiagnosticWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

/** A `DiagLogger` that prints {@link describeDiagnostic} and nothing of what it is given. */
export class SafeDiagLogger implements DiagLogger {
  constructor(private readonly write: DiagnosticWriter = toStderr) {}

  error(...args: unknown[]): void {
    this.write(describeDiagnostic('ERROR', args));
  }
  warn(...args: unknown[]): void {
    this.write(describeDiagnostic('WARN', args));
  }
  info(...args: unknown[]): void {
    this.write(describeDiagnostic('INFO', args));
  }
  debug(...args: unknown[]): void {
    this.write(describeDiagnostic('DEBUG', args));
  }
  verbose(...args: unknown[]): void {
    this.write(describeDiagnostic('VERBOSE', args));
  }
}

/**
 * Installs the safe logger as the global `diag` logger, at the level
 * `OTEL_LOG_LEVEL` in `env` asks for (NONE when unset: nothing printed, as
 * before). An unknown level is reported once, by {@link UNKNOWN_LOG_LEVEL}.
 * Returns what installs the same logger at the same level again, silently.
 */
export function installSafeDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  write: DiagnosticWriter = toStderr,
): () => void {
  const requested = requestedLogLevel(env.OTEL_LOG_LEVEL);
  if (requested === 'unknown') write(`[telemetry] WARN configuration: ${UNKNOWN_LOG_LEVEL}`);
  const logLevel =
    requested === null
      ? DiagLogLevel.NONE
      : requested === 'unknown'
        ? DiagLogLevel.INFO
        : requested;
  const logger = new SafeDiagLogger(write);
  const install = (): void => {
    diag.setLogger(logger, { logLevel, suppressOverrideMessage: true });
  };
  install();
  return install;
}

/**
 * `construct()` with `OTEL_LOG_LEVEL` hidden from `process.env`, so a NodeSDK
 * constructed in it installs no console logger of its own; restored after,
 * exactly as it was (present or not).
 */
export function withoutSdkLogLevel<T>(construct: () => T): T {
  const had = Object.hasOwn(process.env, 'OTEL_LOG_LEVEL');
  const value = process.env.OTEL_LOG_LEVEL;
  delete process.env.OTEL_LOG_LEVEL;
  try {
    return construct();
  } finally {
    if (had) process.env.OTEL_LOG_LEVEL = value;
  }
}
