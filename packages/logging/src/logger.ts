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
  /**
   * Where JSON lines go instead of stdout; for tests. Takes precedence over
   * `pretty`. A plain stream only: a pino multistream or transport throws.
   */
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
    // A handler must never throw: it would be an uncaught exception. A closed
    // pipe ends output; any other failure is left to the next write.
    if (error.code === 'EPIPE') stdout.write = () => true;
  });
  return stdout;
}

/**
 * Only a plain stream is accepted as `destination` (a Writable,
 * `pino.destination`); a pino multistream or transport is refused when the
 * logger is created (Codex on #290, r4 F5, r5 R5-2/R5-3):
 *
 * - a transport (`pino.transport(...)`) routes records to its targets by
 *   numeric level, and this logger writes the level as a word, so its targets
 *   would silently drop every record — at any depth of nesting;
 * - a multistream stays open to its holder: a member added through the
 *   caller's own reference, or one of a nested multistream, would have no
 *   `error` listener, and a late write failure would be an uncaught exception.
 *
 * Fan-out is built here, never passed in: the only multistream a logger has
 * is the one OpenTelemetry's pino instrumentation creates, behind the scrub.
 * Nothing in the repository passes either; the built-in `pretty` option is the
 * one supported transport.
 */
function rejectComposite(destination: DestinationStream | undefined): void {
  if (typeof destination !== 'object' || destination === null) return;
  const candidate = destination as { streams?: unknown; add?: unknown };
  const multistream = 'streams' in candidate || typeof candidate.add === 'function';
  const transport =
    (destination.constructor as { name?: string } | undefined)?.name === 'ThreadStream';
  if (multistream || transport) {
    throw new Error(
      `@rasta/logging: a pino ${transport ? 'transport (pino.transport)' : 'multistream'} ` +
        'is not supported as `destination`: pass a plain stream (pino.destination, a Writable) ' +
        'or use `pretty`.',
    );
  }
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

  rejectComposite(destination);
  const raw = openDestination(destination, pretty);
  let output: DestinationStream = raw;

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

  const logger = pino(options, raw);

  // Every line leaves through this: credentials in any string of it are
  // removed and its length is bounded, whatever produced it. It wraps the
  // stream the logger *ended up with*, not the one it was given: when
  // OpenTelemetry's pino instrumentation is active it has already replaced that
  // stream with a multistream that also feeds the OTel Logs API, and wrapping
  // the whole of it puts every consumer behind the scrub.
  const symbols = pino.symbols as unknown as { streamSym: symbol };
  const loggerState = logger as unknown as Record<symbol, DestinationStream>;
  output = scrubbingDestination(loggerState[symbols.streamSym] ?? raw);
  loggerState[symbols.streamSym] = output;
  return logger;
}

/** Child logger scoped to a component, so its lines are filterable. */
export function childLogger(parent: Logger, component: string): Logger {
  return parent.child({ component });
}

export type { Logger };
