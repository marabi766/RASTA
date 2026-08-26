import pino, { type Logger, type LoggerOptions } from 'pino';
import { buildRedactionPaths, REDACTED, scrubMessage } from './redaction';

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

export function createLogger(config: LoggerConfig): Logger {
  const {
    serviceName,
    serviceVersion = '0.0.0',
    environment = process.env.NODE_ENV ?? 'development',
    level = process.env.LOG_LEVEL ?? 'info',
    pretty = environment === 'development',
  } = config;

  const options: LoggerOptions = {
    level,
    base: { service: serviceName, version: serviceVersion, env: environment },

    // Attached to every line, evaluated per call so late-bound context is seen.
    mixin() {
      return contextProvider?.() ?? {};
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
      logMethod(args, method) {
        // Credentials embedded in free-text messages escape key-based
        // redaction; the classic case is a driver error echoing its DSN.
        const scrubbed = args.map((arg) => (typeof arg === 'string' ? scrubMessage(arg) : arg));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },

    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (pretty) {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      });
    } catch {
      // pino-pretty is an optional peer. Falling back to JSON is strictly
      // better than failing to start because the dev formatter is missing.
      return pino(options);
    }
  }

  return pino(options);
}

/** Child logger scoped to a component, so its lines are filterable. */
export function childLogger(parent: Logger, component: string): Logger {
  return parent.child({ component });
}

export type { Logger };
