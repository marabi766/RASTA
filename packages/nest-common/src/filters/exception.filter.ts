import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ERROR_CODES, type ApiError, type ErrorCode, type ErrorDetail } from '@rasta/contracts';
import type { Logger } from '@rasta/logging';
import { RastaError, isRastaError } from '../errors/rasta-error';
import { tryGetContext } from '../context/request-context';

export const EXCEPTION_FILTER_LOGGER = Symbol('RASTA_EXCEPTION_FILTER_LOGGER');

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
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
 *    error's message is how connection strings and file paths leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(EXCEPTION_FILTER_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const context = tryGetContext();

    const { status, code, message, details, internalContext } = this.normalize(exception);

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
      err: exception instanceof Error ? exception : new Error(String(exception)),
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

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    internalContext?: Record<string, unknown>;
  } {
    if (isRastaError(exception)) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        internalContext: exception.internalContext,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: httpStatusToCode(status),
        message: extractHttpMessage(exception),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      // Deliberately generic. The real message is in the log.
      message: 'An unexpected error occurred',
      internalContext: {
        originalMessage: exception instanceof Error ? exception.message : String(exception),
      },
    };
  }
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
