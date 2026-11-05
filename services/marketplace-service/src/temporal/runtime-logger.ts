import { Runtime, type Logger as TemporalLogger, type RuntimeOptions } from '@temporalio/worker';
import { setLogger, setLogVerbosity, logVerbosity } from '@grpc/grpc-js';
import { assertTemporalDiagnosticsSafe } from '@rasta/config';
import { createLogger, type Logger } from '@rasta/logging';
import { foreignFailure } from './foreign-failure';
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
 * log whole (Codex on #296, F1). This one reports fixed categories and
 * allowlisted error codes, discarding SDK text and metadata.
 * It never throws: the SDK calls it from inside activity and workflow
 * processing.
 */
export class TemporalRuntimeLogger implements TemporalLogger {
  constructor(private readonly base: Logger) {}

  log(level: TemporalLevel, message: string, meta?: Record<string | symbol, unknown>): void {
    // Core and JS diagnostics can contain the endpoint in free text and arbitrary
    // metadata. Substring scrubbing cannot recognize a plain username or key.
    let failure = foreignFailure(undefined);
    let core = false;
    try {
      failure = foreignFailure(meta?.error);
      core = meta?.sdkComponent === 'core';
    } catch {
      // Hostile metadata still gets a fixed diagnostic.
    }
    try {
      const category =
        message === 'Activity failed'
          ? 'Activity failed'
          : 'Temporal SDK diagnostic (TEMPORAL_ADDRESS)';
      this.base[LEVELS[level] ?? 'info'](
        { component: 'temporal', ...(core ? { sdkComponent: 'core' } : {}), failure },
        category,
      );
    } catch {
      // A log call must not fail the activity or workflow it describes.
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
 *
 * No `shutdownSignals`: by default the SDK stops every worker on four signals,
 * two of which (SIGQUIT, SIGUSR2) the service's shutdown does not handle, leaving
 * a live API with no worker. Now SIGTERM and SIGINT stop it through the service's
 * shutdown, and those two end the process by Node's default action (FU-104).
 */
export function temporalRuntimeOptions(base: Logger): RuntimeOptions {
  return {
    logger: new TemporalRuntimeLogger(base),
    telemetryOptions: { logging: { forward: {} } },
    shutdownSignals: [],
  };
}

let installed = false;

/** The declared grpc-js dependency is the same instance both Temporal owners
 * resolve (verified by the real-SDK regressions, including the native path).
 * NativeConnection uses Core, whose separate diagnostics are forwarded above.
 * Reinstall before every connection, even when Runtime was already installed.
 */
function installGrpcDiagnostics(base: Logger): void {
  const report = (): void => {
    try {
      base.error({ component: 'temporal-grpc' }, 'Temporal gRPC diagnostic (TEMPORAL_ADDRESS)');
    } catch {
      // Diagnostic reporting cannot become an SDK failure or a raw fallback.
    }
  };
  try {
    setLogger({ error: report, info: report, debug: report });
    setLogVerbosity(logVerbosity.ERROR);
  } catch {
    // An unavailable SDK logging API must refuse connection without its diagnostics.
    throw new Error('TEMPORAL_ADDRESS: gRPC diagnostic boundary unavailable');
  }
}

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
  const base = createLogger({
    serviceName: SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    environment: env.NODE_ENV,
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  installGrpcDiagnostics(base);
  assertTemporalDiagnosticsSafe();
  if (installed) return;
  Runtime.install(temporalRuntimeOptions(base));
  installed = true;
}
