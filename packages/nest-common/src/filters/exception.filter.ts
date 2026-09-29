import {
  BadRequestException,
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ERROR_CODES, type ApiError, type ErrorCode, type ErrorDetail } from '@rasta/contracts';
import type { Logger } from '@rasta/logging';
import {
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  RastaError,
  isRastaError,
} from '../errors/rasta-error';
import { safeLogText } from '../errors/safe-log-text';
import { tryGetContext } from '../context/request-context';

export const EXCEPTION_FILTER_LOGGER = Symbol('RASTA_EXCEPTION_FILTER_LOGGER');

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): unknown;
}

/**
 * Turns every thrown value into the platform error shape.
 *
 * Two rules govern what reaches the client:
 *
 *  - The response carries a stable `code` and a human message. It never
 *    carries a stack trace, a table name, a fragment of SQL, or any internal
 *    context — those go to the log, keyed by the same correlationId the client
 *    receives, so support can join them without the client ever seeing them.
 *
 *  - An unrecognised exception becomes a generic 500. Echoing an arbitrary
 *    error's message is how connection strings and file paths leak. So does a
 *    Nest `HttpException` of 5xx: its text is replaced the same way.
 *
 * And one rule governs what reaches the log (S-09): a message this service
 * did not author — the unrecognised error's, a driver's, a cause's — is
 * logged only through `safeLogText` (credentials scrubbed, control characters
 * stripped, at most 200 characters), the rule `EventConsumer` applies to
 * handler text. The error is logged as {@link LoggedError}, not as the raw
 * object, so neither its message nor an enumerable property of it (a driver's
 * `meta`, say) escapes that rule; the stack keeps its frames, not its first
 * line, which repeats the message.
 *
 * The response carries one header of the error's own, and only one:
 * `Retry-After`, from {@link RastaError.retryAfterSeconds} — a typed field the
 * thrower sets on purpose. Nothing in `internalContext` ever becomes a header.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(EXCEPTION_FILTER_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const context = tryGetContext();

    const { status, code, message, details, internalContext, logged } = this.normalize(exception);

    const body: ApiError = {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
      correlationId: context?.correlationId ?? 'unknown',
      ...(context?.traceId ? { traceId: context.traceId } : {}),
      timestamp: new Date().toISOString(),
      ...(context?.path ? { path: context.path } : {}),
    };

    const logPayload = {
      err: logged ?? loggableError(exception),
      errorCode: code,
      status,
      internalContext,
      method: context?.method,
      path: context?.path,
    };

    // 5xx is our fault and needs a stack. 4xx is the caller's and would
    // otherwise fill the error log with routine validation failures.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(logPayload, `Unhandled error: ${message}`);
    } else if (status === HttpStatus.FORBIDDEN || code === ERROR_CODES.TENANT_MISMATCH) {
      // Denials are the signal worth watching: a burst of them is what
      // tenant-boundary probing looks like.
      this.logger.warn(logPayload, `Access denied: ${code}`);
    } else {
      this.logger.debug(logPayload, `Request rejected: ${code}`);
    }

    const retryAfter = isRastaError(exception)
      ? retryAfterHeader(exception.retryAfterSeconds)
      : undefined;
    if (retryAfter !== undefined) response.setHeader('Retry-After', retryAfter);

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    internalContext?: Record<string, unknown>;
    /** How the error is logged, when its own message may not be. */
    logged?: LoggedError;
  } {
    if (isRastaError(exception)) {
      // A server-side failure keeps its status and code, but its words stay
      // with the server: a service writes those messages for operators, and
      // they name records ("Approval <id> vanished …"). The client gets the
      // generic text; the log gets the original, made safe.
      //
      // The one exception is an explicit opt-in (`clientSafe`, set by
      // `RastaError.internalClientSafe`) for a fixed, input-free message the
      // client needs. It is read from the flag, never from the content.
      if (exception.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        return {
          status: exception.status,
          code: exception.code,
          message: exception.clientSafe ? exception.message : GENERIC_SERVER_ERROR,
          internalContext: {
            ...exception.internalContext,
            originalMessage: safeLogText(exception.message),
          },
        };
      }
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        internalContext: exception.internalContext,
      };
    }

    // body-parser's refusals of a body it will not read. Nest passes these
    // through untouched (only its SyntaxError becomes a 400, below), so
    // without this they would land in the 500 branch. Matched by body-parser's
    // own `type` and status, from an allowlist; the text is ours, because
    // theirs can name what the client sent (`unsupported charset "…"`).
    const refusal = bodyParserRefusal(exception);
    if (refusal) {
      return {
        ...refusal,
        logged: { ...loggableError(exception), message: refusal.message },
      };
    }

    // Nest's own reading of a request it could not parse (S-09). The platform
    // never throws `BadRequestException` itself — its 400s are `RastaError`s —
    // so one reaching here was made by the framework from client input: Nest
    // maps body-parser's `SyntaxError` (a malformed JSON body) and Express's
    // `URIError` (a malformed percent-encoding) to `new
    // BadRequestException(err.message)`, and V8's JSON message quotes the
    // bytes it choked on. The client and the log get fixed text; the log
    // keeps the frames. Which text is chosen reads the message, but nothing of
    // it is repeated.
    if (exception instanceof BadRequestException) {
      const message = /JSON/.test(exception.message) ? MALFORMED_JSON_BODY : MALFORMED_REQUEST;
      return {
        status: HttpStatus.BAD_REQUEST,
        code: httpStatusToCode(HttpStatus.BAD_REQUEST),
        message,
        logged: { ...loggableError(exception), message },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        return {
          status,
          code: httpStatusToCode(status),
          message: GENERIC_SERVER_ERROR,
          internalContext: { originalMessage: safeLogText(extractHttpMessage(exception)) },
        };
      }
      return {
        status,
        code: httpStatusToCode(status),
        message: extractHttpMessage(exception),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      // Deliberately generic. The real message is in the log, made safe.
      message: GENERIC_SERVER_ERROR,
      internalContext: {
        originalMessage: safeLogText(
          exception instanceof Error ? exception.message : String(exception),
        ),
      },
    };
  }
}

/**
 * The `Retry-After` value for a wait in seconds: delay-seconds (RFC 9110
 * § 10.2.3), a whole number rounded up, clamped to
 * [{@link RETRY_AFTER_MIN_SECONDS}, {@link RETRY_AFTER_MAX_SECONDS}].
 * Undefined — no header — for anything that is not a finite number.
 */
function retryAfterHeader(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const bounded = Math.min(
    RETRY_AFTER_MAX_SECONDS,
    Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(seconds)),
  );
  return String(bounded);
}

/** What a client is told about a failure that is the server's. */
const GENERIC_SERVER_ERROR = 'An unexpected error occurred';

/** What a client is told when its body is not JSON — never the parser's words. */
const MALFORMED_JSON_BODY = 'The request body is not valid JSON';

/** What a client is told about any other request the framework could not read. */
const MALFORMED_REQUEST = 'The request could not be read';

/**
 * body-parser's refusals this filter answers, by the `type` body-parser sets
 * on its (`http-errors`) error. Any other type is not recognised here.
 */
const BODY_PARSER_REFUSALS: Readonly<
  Record<string, { status: number; code: ErrorCode; message: string }>
> = {
  'entity.too.large': {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    code: ERROR_CODES.PAYLOAD_TOO_LARGE,
    message: 'The request body is too large',
  },
  'charset.unsupported': {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
    message: 'The request body is in a charset this service does not accept',
  },
  'encoding.unsupported': {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
    message: 'The request body is in a content encoding this service does not accept',
  },
};

function bodyParserRefusal(
  exception: unknown,
): { status: number; code: ErrorCode; message: string } | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (
    typeof type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(BODY_PARSER_REFUSALS, type)
  ) {
    return undefined;
  }
  const refusal = BODY_PARSER_REFUSALS[type];
  return refusal && refusal.status === status ? refusal : undefined;
}

/** How deep a chain of `cause`s is followed into the log. */
const MAX_CAUSE_DEPTH = 3;

/** How many stack frames a logged error keeps. */
const MAX_STACK_FRAMES = 30;

/** An error as the log records it: class, code, safe message, frames, cause. */
export interface LoggedError {
  type: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: LoggedError;
}

export function loggableError(error: unknown, depth = 0): LoggedError {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: safeLogText(String(error)) };
  }
  // Frames only: a stack's first line is `Name: message`, the text above.
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .join('\n');
  return {
    type: error.name,
    ...(isRastaError(error) ? { code: error.code } : {}),
    message: safeLogText(error.message),
    ...(frames ? { stack: frames } : {}),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: loggableError(error.cause, depth + 1) }
      : {}),
  };
}

export function httpStatusToCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ERROR_CODES.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ERROR_CODES.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ERROR_CODES.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ERROR_CODES.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ERROR_CODES.CONFLICT;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ERROR_CODES.PAYLOAD_TOO_LARGE;
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ERROR_CODES.BUSINESS_RULE_VIOLATION;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ERROR_CODES.RATE_LIMIT_EXCEEDED;
    case HttpStatus.NOT_IMPLEMENTED:
      return ERROR_CODES.NOT_IMPLEMENTED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ERROR_CODES.UPSTREAM_UNAVAILABLE;
    case HttpStatus.GATEWAY_TIMEOUT:
      return ERROR_CODES.UPSTREAM_TIMEOUT;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.MALFORMED_REQUEST;
  }
}

function extractHttpMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
  }
  return exception.message;
}

export { RastaError };
