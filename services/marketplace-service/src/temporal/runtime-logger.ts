import { Runtime, type Logger as TemporalLogger, type RuntimeOptions } from '@temporalio/worker';
import { createLogger, scrubMessage, type Logger } from '@rasta/logging';
import { scrubLogValue } from '@rasta/nest-common';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';

type TemporalLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVELS = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const satisfies Record<TemporalLevel, string>;

/**
 * The Temporal SDK's logger over the service's pino logger.
 *
 * The SDK has a logger of its own: an activity that throws is logged by the
 * activity executor with the error — message, stack and `cause` chain — and
 * the default one writes that to stderr as it is. An upstream refusal that
 * quotes a DSN or a bearer token, or a response body of 200 kB, reached the
 * log whole (Codex on #296, F1). This one scrubs and caps the message, and
 * scrubs every metadata field (an `error` among them), before it is written.
 * It never throws: the SDK calls it from inside activity and workflow
 * processing.
 */
export class TemporalRuntimeLogger implements TemporalLogger {
  constructor(private readonly base: Logger) {}

  log(level: TemporalLevel, message: string, meta?: Record<string | symbol, unknown>): void {
    try {
      const { error, ...fields } =
        meta === undefined
          ? ({} as Record<string, unknown>)
          : (scrubLogValue(meta) as Record<string, unknown>);
      this.base[LEVELS[level] ?? 'info'](
        // The SDK names the failure `error`; pino serializes an Error (message,
        // stack, cause chain) only under `err`, and would drop it otherwise.
        { ...fields, ...(error === undefined ? {} : { err: error }), component: 'temporal' },
        scrubMessage(String(message)),
      );
    } catch {
      // A log call must not fail the activity or the workflow task it describes.
    }
  }

  trace(message: string, meta?: Record<string | symbol, unknown>): void {
    this.log('TRACE', message, meta);
  }

  debug(message: string, meta?: Record<string | symbol, unknown>): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: Record<string | symbol, unknown>): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: Record<string | symbol, unknown>): void {
    this.log('WARN', message, meta);
  }

  error(message: string, meta?: Record<string | symbol, unknown>): void {
    this.log('ERROR', message, meta);
  }
}

/**
 * The runtime's options: {@link TemporalRuntimeLogger} as the SDK's logger, and
 * Core's own logs forwarded to it. Core — the native layer under
 * `NativeConnection` and `Worker` — logs apart from `logger`: a retried gRPC
 * status or a poll error at WARN, written by its console exporter straight to
 * stderr, unscrubbed and uncapped (Codex on #296, r2 F1). `logging.forward`
 * sends those records through `logger` as well, under Core's default filter.
 */
export function temporalRuntimeOptions(base: Logger): RuntimeOptions {
  return {
    logger: new TemporalRuntimeLogger(base),
    telemetryOptions: { logging: { forward: {} } },
  };
}

let installed = false;

/**
 * Installs the Temporal runtime with {@link temporalRuntimeOptions}. Call it
 * before the first `NativeConnection`, `Worker` or `Connection` of the process:
 * the SDK builds its runtime on first use, with its default (raw) logger, and
 * cannot be given another afterwards. Idempotent; the worker and the client
 * both call it, whichever comes first installs.
 */
export function installTemporalRuntimeLogger(
  env: Pick<MarketplaceEnv, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_VERSION'>,
): void {
  if (installed) return;
  Runtime.install(
    temporalRuntimeOptions(
      createLogger({
        serviceName: SERVICE_NAME,
        serviceVersion: env.SERVICE_VERSION,
        environment: env.NODE_ENV,
        level: env.LOG_LEVEL,
        pretty: env.NODE_ENV === 'development',
      }),
    ),
  );
  installed = true;
}
