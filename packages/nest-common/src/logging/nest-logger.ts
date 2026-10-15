import type { LoggerService } from '@nestjs/common';
import { createLogger, scrubMessage, type Logger, type LoggerConfig } from '@rasta/logging';
import { EXCEPTION_FILTER_LOGGER } from '../filters/exception.filter';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Distinct Nest contexts are class names; the cap only guards a caller minting them. */
const MAX_CHILD_LOGGERS = 256;

const SCRUB_DEPTH = 4;
/** A string Nest passed as an error's stack, as opposed to a further message. */
const STACK_LINE = /\n\s+at /;

/**
 * Free text inside a structured field. Pino's `err` serializer copies an
 * error's message, stack and cause as they are, and key-based redaction cannot
 * see a DSN or bearer token inside a string, so strings and errors are scrubbed
 * (and capped, by `scrubMessage`) here. Depth-limited and cycle-safe.
 */
function scrubValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubMessage(value);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (seen.has(value) || depth >= SCRUB_DEPTH) return '[Truncated]';
  seen.add(value);
  if (value instanceof Error) {
    // Still an Error, so pino's `err` serializer keeps the type and the
    // `caused by` chain; only its text is replaced.
    const out = new Error(scrubMessage(value.message));
    out.name = value.name;
    out.stack = value.stack === undefined ? undefined : scrubMessage(value.stack);
    if ('cause' in value && value.cause !== undefined) {
      out.cause = scrubValue(value.cause, depth + 1, seen);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, depth + 1, seen);
  return out;
}

/**
 * Nest's `LoggerService` over the service's pino logger.
 *
 * `new Logger(Name)` from `@nestjs/common` writes through whatever logger the
 * application registered with `app.useLogger`, and falls back to Nest's own
 * console logger otherwise — which prints an error's message, a driver's DSN
 * or a failing URL's credential raw (Codex on #290, F4). Registering this
 * adapter sends every one of those calls through the logger the service
 * already builds, so message scrubbing and capping (`@rasta/logging`) apply to
 * them as to any other line. Levels and the context name are kept: Nest's
 * `log` is `info`, `verbose` is `trace`, and the context becomes `context`.
 */
export class NestLoggerAdapter implements LoggerService {
  private readonly children = new Map<string, Logger>();

  constructor(private readonly base: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params, true);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params, true);
  }

  private write(level: Level, message: unknown, params: unknown[], mayCarryStack = false): void {
    // Nest appends the context as the last string parameter; an error's stack
    // precedes it (`error(message, stack, context)`).
    const rest = [...params];
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const fields: Record<string, unknown> = {};

    let stack: string | undefined;
    if (
      mayCarryStack &&
      typeof rest[rest.length - 1] === 'string' &&
      STACK_LINE.test(rest[rest.length - 1] as string)
    ) {
      stack = rest.pop() as string;
    }
    const texts: string[] = [];
    if (message instanceof Error) {
      texts.push(message.message);
      stack ??= message.stack;
    } else if (typeof message === 'string') {
      texts.push(message);
    } else if (message !== null && typeof message === 'object') {
      // Structured by the caller: pino redacts it by key, and `scrubValue`
      // takes what key-based redaction cannot — an `err` field's message.
      Object.assign(fields, scrubValue(message));
    } else {
      texts.push(String(message));
    }
    // `logger.error({ ... }, 'what happened')` is how the services call it; Nest
    // reads the string as a further message (or a stack), so it is the text here.
    const extra: unknown[] = [];
    for (const param of rest) {
      if (typeof param === 'string') texts.push(param);
      else extra.push(scrubValue(param));
    }
    if (stack !== undefined) fields.stack = scrubMessage(stack);
    if (extra.length > 0) fields.params = extra;

    const target = this.forContext(context);
    // `logMethod` scrubs and caps a string message; passing it as the second
    // argument keeps it on that path.
    if (texts.length === 0) target[level](fields);
    else target[level](fields, texts.join(' '));
  }

  private forContext(context: string | undefined): Logger {
    if (context === undefined) return this.base;
    let child = this.children.get(context);
    if (child === undefined) {
      child = this.base.child({ context });
      if (this.children.size < MAX_CHILD_LOGGERS) this.children.set(context, child);
    }
    return child;
  }
}

/** The surface of a Nest application this needs; keeps tests free of a full app. */
export interface LoggerHost {
  get<T>(token: symbol, options?: { strict: boolean }): T;
  useLogger(logger: LoggerService): void;
}

/**
 * One call per service, right after `NestFactory.create(..., { bufferLogs: true })`:
 * routes Nest's own logger and every `new Logger(...)` through the service's
 * pino logger (the one the exception filter already uses), and flushes what
 * was buffered. Pass `logger` to supply one directly.
 */
export function installNestLogger(app: LoggerHost, logger?: Logger): NestLoggerAdapter {
  const adapter = new NestLoggerAdapter(
    logger ?? app.get<Logger>(EXCEPTION_FILTER_LOGGER, { strict: false }),
  );
  app.useLogger(adapter);
  return adapter;
}

/**
 * For a failure before the application (and its logger) exists, or after it:
 * a startup error often echoes a connection string, so it must not go to
 * `console.error` raw.
 */
export function logFatal(config: LoggerConfig, message: string, error?: unknown): void {
  const logger = createLogger({ ...config, pretty: false });
  const fields: Record<string, unknown> = {};
  if (error instanceof Error) {
    fields.err = {
      type: error.name,
      message: scrubMessage(error.message),
      stack: error.stack === undefined ? undefined : scrubMessage(error.stack),
    };
  } else if (error !== undefined) {
    fields.err = { message: scrubMessage(String(error)) };
  }
  logger.fatal(fields, message);
}
