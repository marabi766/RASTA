import {
  Catch,
  Inject,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { HttpArgumentsHost } from '@nestjs/common/interfaces';
import type { Logger } from '@rasta/logging';
import { AllExceptionsFilter, EXCEPTION_FILTER_LOGGER, tryGetContext } from '@rasta/nest-common';
import { RefusalAuditRecorder } from './refusal-audit.recorder';
import { refusalSiteOf } from './refusal-sites';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

interface RouteAwareRequest {
  method?: string;
  /** Express's matched route. `path` is the template, never the concrete URL. */
  route?: { path?: unknown };
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

/**
 * Runs the platform filter against a response that records instead of sending.
 *
 * This is how the refusal filter learns the **final** classification — the
 * status and body the platform would have sent — without re-deriving it and
 * risking a second opinion that disagrees with the first. The platform filter
 * reads only `switchToHttp().getResponse()`; every other accessor is the real
 * host's.
 */
function capturePlatformResponse(
  platform: AllExceptionsFilter,
  exception: unknown,
  host: ArgumentsHost,
): CapturedResponse | undefined {
  let status: number | undefined;
  let body: unknown;
  let written = false;

  const recorder: HttpResponse = {
    status(code: number): HttpResponse {
      status = code;
      return recorder;
    },
    json(value: unknown): void {
      body = value;
      written = true;
    },
  };

  const http = host.switchToHttp();
  const capturingHttp: HttpArgumentsHost = {
    getRequest: () => http.getRequest(),
    getNext: () => http.getNext(),
    getResponse: <T>() => recorder as unknown as T,
  };
  const capturingHost: ArgumentsHost = {
    getArgs: () => host.getArgs(),
    getArgByIndex: (index: number) => host.getArgByIndex(index),
    switchToRpc: () => host.switchToRpc(),
    switchToWs: () => host.switchToWs(),
    switchToHttp: () => capturingHttp,
    getType: () => host.getType(),
  } as ArgumentsHost;

  platform.catch(exception, capturingHost);
  return written && status !== undefined ? { status, body } : undefined;
}

const codeOf = (body: unknown): string | undefined => {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : '';
  return typeof code === 'string' ? code : undefined;
};

/**
 * identity-service's exception filter: the platform filter, plus refusal audit
 * capture for the allowlisted refusal sites (ADR-053 § 4, AUD-004 Phase C1).
 *
 * ## The response is the platform filter's, byte for byte
 *
 * Every exception is shaped by `AllExceptionsFilter` — the same status, code,
 * message, correlation id and path as every other service. For an exception no
 * refusal site marked, that happens synchronously and this class adds nothing.
 *
 * For a marked one, the platform response is built first and held; the capture
 * runs with the classification that response carries; and then exactly that
 * response is sent — whether the capture recorded, timed out, failed or threw.
 * The capture can delay the refusal by at most
 * `SECURITY_EVENT_CAPTURE_TIMEOUT_MS`. It can never change it, and it can never
 * turn it into anything other than a refusal (A-12).
 */
@Catch()
@Injectable()
export class RefusalAuditExceptionFilter implements ExceptionFilter {
  private readonly platform: AllExceptionsFilter;

  constructor(
    @Inject(EXCEPTION_FILTER_LOGGER) private readonly logger: Logger,
    private readonly recorder: RefusalAuditRecorder,
  ) {
    this.platform = new AllExceptionsFilter(logger);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http' || refusalSiteOf(exception) === undefined) {
      this.platform.catch(exception, host);
      return;
    }

    let captured: CapturedResponse | undefined;
    try {
      captured = capturePlatformResponse(this.platform, exception, host);
    } catch {
      captured = undefined;
    }
    if (captured === undefined) {
      // Not expected — the platform filter always writes. If it ever did not,
      // the refusal is still answered the platform way, without capture.
      this.platform.catch(exception, host);
      return;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<RouteAwareRequest>();
    const response = http.getResponse<HttpResponse>();
    // Read now, inside the request's async context, before anything is awaited.
    const context = tryGetContext();
    const route = request.route?.path;

    void this.recordThenRespond(response, captured, {
      exception,
      status: captured.status,
      code: codeOf(captured.body),
      method: request.method,
      route: typeof route === 'string' ? route : undefined,
      context,
    });
  }

  private async recordThenRespond(
    response: HttpResponse,
    captured: CapturedResponse,
    observation: Parameters<RefusalAuditRecorder['record']>[0],
  ): Promise<void> {
    try {
      await this.recorder.record(observation);
    } catch {
      // `record()` does not throw. This exists so that if it ever did, the
      // refusal below is still sent.
    } finally {
      try {
        response.status(captured.status).json(captured.body);
      } catch (error) {
        this.logger.error(
          { errorClass: error instanceof Error ? error.name : 'Error' },
          'Refusal response could not be written',
        );
      }
    }
  }
}
