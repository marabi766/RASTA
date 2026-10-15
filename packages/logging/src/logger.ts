import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { scrubbedErrorSerializer } from './error-serializer';
import { buildRedactionPaths, REDACTED } from './redaction';
import { scrubbingDestination, writeFallback } from './scrubbing-destination';

/**
 * Fields that identify *where* a log line came from and *which* request
 * produced it. Populated by the HTTP layer and carried across every async hop,
 * so one correlationId links a browser click to a ledger entry.
 *
 * The logging package deliberately does not own the async storage that holds
 * this — it accepts a provider function instead. That keeps this package
 * framework-free while letting @rasta/nest-common wire in its request context.
 */
export interface LogContext {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
  requestId?: string;
}

export interface LoggerConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  level?: string;
  /** Human-readable output. Never enable in production — it is slow and unparseable. */
  pretty?: boolean;
  /** Where JSON lines go instead of stdout; for tests. Takes precedence over `pretty`. */
  destination?: DestinationStream;
}

let contextProvider: (() => LogContext | undefined) | undefined;

/**
 * Registers the source of per-request context. Called once at startup by the
 * framework adapter; every logger created before or after picks it up, because
 * the mixin reads through this reference at log time.
 */
export function setLogContextProvider(provider: () => LogContext | undefined): void {
  contextProvider = provider;
}

export function clearLogContextProvider(): void {
  contextProvider = undefined;
}

/**
 * The raw stream lines go to: the caller's, else pino-pretty in development,
 * else stdout (a closed pipe is ignored, as pino's own default does).
 */
function openDestination(
  destination: DestinationStream | undefined,
  pretty: boolean,
): DestinationStream {
  if (destination) return destination;

  if (pretty) {
    try {
      return pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }) as DestinationStream;
    } catch {
      // pino-pretty is an optional peer. Falling back to JSON is strictly
      // better than failing to start because the dev formatter is missing.
    }
  }

  const stdout = pino.destination({ dest: process.stdout.fd || 1, sync: true });
  stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    stdout.write = () => true;
  });
  return stdout;
}

export function createLogger(config: LoggerConfig): Logger {
  const {
    serviceName,
    serviceVersion = '0.0.0',
    environment = process.env.NODE_ENV ?? 'development',
    level = process.env.LOG_LEVEL ?? 'info',
    pretty = environment === 'development',
    destination,
  } = config;

  // Every line leaves through this: credentials in any string of it are
  // removed and its length is bounded, whatever produced it.
  const output = scrubbingDestination(openDestination(destination, pretty));

  const options: LoggerOptions = {
    level,
    base: { service: serviceName, version: serviceVersion, env: environment },

    // Attached to every line, evaluated per call so late-bound context is seen.
    mixin() {
      try {
        return contextProvider?.() ?? {};
      } catch {
        // A failing context provider costs the context, never the line.
        return {};
      }
    },

    redact: {
      paths: buildRedactionPaths(),
      censor: REDACTED,
    },

    formatters: {
      // Ship the level as a word. `"level": 30` forces every reader and every
      // log query to memorise pino's numeric scale.
      level(label) {
        return { level: label };
      },
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    hooks: {
      // Interpolation, serializers, redaction and mixins all run inside this
      // call. One that throws (a hostile toString or getter) must not reach
      // the caller: a fixed line is written instead.
      logMethod(args, method) {
        try {
          method.apply(this, args);
        } catch {
          writeFallback(output);
        }
      },
    },

    serializers: {
      err: scrubbedErrorSerializer,
      error: scrubbedErrorSerializer,
    },
  };

  return pino(options, output);
}

/** Child logger scoped to a component, so its lines are filterable. */
export function childLogger(parent: Logger, component: string): Logger {
  return parent.child({ component });
}

export type { Logger };
