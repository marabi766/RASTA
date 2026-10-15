import { format } from 'node:util';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { scrubbedErrorSerializer } from './error-serializer';
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

const PLACEHOLDER = /%[sdifjoOc]/;

function isPlainFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error pino would take a message from: `{ err }` / `{ error }` fields. */
function fieldError(fields: Record<string, unknown>): Error | undefined {
  for (const key of ['err', 'error']) {
    try {
      const value = fields[key];
      if (value instanceof Error) return value;
    } catch {
      // A throwing getter must not take the log line down with it.
    }
  }
  return undefined;
}

/**
 * Rewrites the arguments of a log call so the message pino will print is
 * already final: `(fields?, message?, ...interpolation)` becomes
 * `(fields, scrubbedCappedMessage)`. Covers an explicit string, `%s`-style
 * interpolation (formatted here, then scrubbed as a whole, so a secret in an
 * argument is caught), a message pino would generate from `err`/`error`, and a
 * `msg` field. The structured fields themselves are left to the serializers
 * and key-based redaction.
 */
function finalMessageArgs(args: unknown[]): unknown[] {
  const first = args[0];
  let rest = args.slice(1);
  let fields: Record<string, unknown> | undefined;
  if (first instanceof Error) {
    fields = { err: first };
  } else if (isPlainFields(first)) {
    fields = first;
  } else {
    // `logger.info('text', ...args)`: the message leads.
    rest = args;
  }

  const [text, ...interpolation] = rest;
  let message: string | undefined;
  if (typeof text === 'string') {
    message =
      interpolation.length > 0 && PLACEHOLDER.test(text) ? format(text, ...interpolation) : text;
  } else if (fields) {
    const source = first instanceof Error ? first : fieldError(fields);
    if (source) message = source.message;
    else if (typeof fields.msg === 'string') message = fields.msg;
  }

  if (message === undefined) return fields ? [fields] : args;
  if (fields && typeof fields.msg === 'string') {
    // pino lets an explicit message argument win over a `msg` field; drop the
    // field's raw copy rather than rely on that.
    const { msg: _raw, ...withoutMsg } = fields;
    fields = withoutMsg;
  }
  return fields ? [fields, scrubMessage(message)] : [scrubMessage(message)];
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
        // Every call shape ends here with ONE scrubbed, capped message string:
        // pino would otherwise copy an error's raw message into `msg`, or
        // interpolate arguments into it, after this hook and unscrubbed.
        return method.apply(this, finalMessageArgs(args) as Parameters<typeof method>);
      },
    },

    serializers: {
      err: scrubbedErrorSerializer,
      error: scrubbedErrorSerializer,
    },
  };

  if (destination) return pino(options, destination);

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
