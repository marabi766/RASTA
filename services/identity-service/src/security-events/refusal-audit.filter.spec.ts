import type { ArgumentsHost } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import {
  AllExceptionsFilter,
  RastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { RefusalAuditExceptionFilter } from './refusal-audit.filter';
import { RefusalAuditRecorder, type SecurityEventWriter } from './refusal-audit.recorder';
import { markRefusal, REFUSAL_SITES } from './refusal-sites';

/**
 * The filter's one promise: the response is the platform's, byte for byte,
 * whatever happened to the capture — recorded, failed, timed out or thrown.
 */

const ROUTE = REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION.route;

const context: RequestContext = {
  correlationId: 'COR_FILTER_1',
  requestId: 'REQ_FILTER_1',
  organizationId: 'ORG_A',
  organizationIds: ['ORG_A'],
  userId: 'USR_A',
  roles: ['FLEET_MANAGER'],
  authType: 'USER',
  ip: '203.0.113.7',
  userAgent: 'filter-spec',
  method: 'POST',
  path: ROUTE,
  startedAt: 0,
};

function silentLogger() {
  return { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() };
}

function fakeResponse() {
  const response = {
    status: jest.fn((_code: number) => response),
    json: jest.fn((_body: unknown) => undefined),
  };
  return response;
}

function httpHost(
  request: Record<string, unknown>,
  response: ReturnType<typeof fakeResponse>,
): ArgumentsHost {
  return {
    getType: () => 'http',
    getArgs: () => [request, response],
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
    switchToRpc: () => {
      throw new Error('not rpc');
    },
    switchToWs: () => {
      throw new Error('not ws');
    },
  } as unknown as ArgumentsHost;
}

const refusalRequest = { method: 'POST', route: { path: ROUTE } };

const marked = (): RastaError =>
  markRefusal(RastaError.tenantMismatch('ORG_B', []), 'SWITCH_ACTIVE_ORGANIZATION');

/** What the platform filter alone sends for `exception`, minus its timestamp. */
function platformResponse(exception: unknown): { status: number; body: Record<string, unknown> } {
  const response = fakeResponse();
  runWithContext(context, () =>
    new AllExceptionsFilter(silentLogger() as unknown as Logger).catch(
      exception,
      httpHost(refusalRequest, response),
    ),
  );
  return {
    status: response.status.mock.calls[0]![0],
    body: withoutTimestamp(response.json.mock.calls[0]![0]),
  };
}

function withoutTimestamp(body: unknown): Record<string, unknown> {
  const { timestamp, ...rest } = body as Record<string, unknown>;
  expect(typeof timestamp).toBe('string');
  return rest;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const COUNTED = { id: '01J9ZC0000000000000000TEST', occurrenceCount: 2, created: false };

function recorderWith(
  capture: SecurityEventWriter['capture'],
  timeoutMs = 40,
): RefusalAuditRecorder {
  return new RefusalAuditRecorder({
    store: { capture },
    timeoutMs,
    aggregationWindowSeconds: 60,
    producerVersion: '1.0.0',
    logger: silentLogger() as unknown as Logger,
  });
}

function run(
  filter: RefusalAuditExceptionFilter,
  exception: unknown,
  request: Record<string, unknown> = refusalRequest,
) {
  const response = fakeResponse();
  runWithContext(context, () => filter.catch(exception, httpHost(request, response)));
  return response;
}

describe('RefusalAuditExceptionFilter', () => {
  it('answers an unmarked exception through the platform filter, synchronously and without capture', () => {
    const recorder = { record: jest.fn() } as unknown as RefusalAuditRecorder;
    const filter = new RefusalAuditExceptionFilter(silentLogger() as unknown as Logger, recorder);
    const exception = RastaError.insufficientRole(['UNION_ADMIN'], []);

    const response = run(filter, exception);

    // Written before `catch` returned.
    expect(response.json).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(withoutTimestamp(response.json.mock.calls[0]![0])).toEqual(
      platformResponse(exception).body,
    );
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('hands the recorder the final classification, the method and the route template', async () => {
    const record = jest.fn(async () => 'recorded' as const);
    const filter = new RefusalAuditExceptionFilter(
      silentLogger() as unknown as Logger,
      {
        record,
      } as unknown as RefusalAuditRecorder,
    );
    const exception = marked();

    const response = run(filter, exception);
    await until(() => response.json.mock.calls.length > 0);

    expect(record).toHaveBeenCalledWith({
      exception,
      status: 403,
      code: ERROR_CODES.TENANT_MISMATCH,
      method: 'POST',
      route: ROUTE,
      context: expect.objectContaining({ userId: 'USR_A', organizationId: 'ORG_A' }),
    });
  });

  it.each(['LIST_USERS', 'CREATE_USER', 'ADD_MEMBERSHIP'] as const)(
    'captures a roles-guard denial marked %s with its own classification, and sends the platform response unchanged',
    async (siteName) => {
      const site = REFUSAL_SITES[siteName];
      const record = jest.fn(async () => 'recorded' as const);
      const filter = new RefusalAuditExceptionFilter(
        silentLogger() as unknown as Logger,
        { record } as unknown as RefusalAuditRecorder,
      );
      const siteRequest = { method: site.method, route: { path: site.route } };
      const exception = markRefusal(
        RastaError.insufficientRole(['ORGANIZATION_ADMIN', 'UNION_ADMIN'], ['FLEET_MANAGER']),
        siteName,
      );
      const unmarked = RastaError.insufficientRole(
        ['ORGANIZATION_ADMIN', 'UNION_ADMIN'],
        ['FLEET_MANAGER'],
      );
      const expected = platformResponse(unmarked);

      const response = run(filter, exception, siteRequest);
      await until(() => response.json.mock.calls.length > 0);

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          exception,
          status: 403,
          code: ERROR_CODES.INSUFFICIENT_ROLE,
          method: site.method,
          route: site.route,
        }),
      );
      expect(response.status).toHaveBeenCalledTimes(1);
      expect(response.status).toHaveBeenCalledWith(403);
      expect(withoutTimestamp(response.json.mock.calls[0]![0])).toEqual(expected.body);
      expect(expected.body).toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    },
  );

  it('answers an unmarked INSUFFICIENT_ROLE on GET /v1/users synchronously and without capture', () => {
    const recorder = { record: jest.fn() } as unknown as RefusalAuditRecorder;
    const filter = new RefusalAuditExceptionFilter(silentLogger() as unknown as Logger, recorder);

    const response = run(filter, RastaError.insufficientRole(['UNION_ADMIN'], []), {
      method: 'GET',
      route: { path: '/v1/users' },
    });

    expect(response.json).toHaveBeenCalledTimes(1);
    expect(recorder.record).not.toHaveBeenCalled();
  });

  describe('sends exactly the platform response, once, whatever the capture did', () => {
    const cases: [string, () => RefusalAuditRecorder][] = [
      [
        'recorded as a new window row',
        () => recorderWith(async () => ({ ...COUNTED, created: true })),
      ],
      ['counted into an open window row', () => recorderWith(async () => COUNTED)],
      [
        'failed',
        () =>
          recorderWith(async () => {
            throw new Error('database down');
          }),
      ],
      ['timed out', () => recorderWith(() => new Promise<typeof COUNTED>(() => undefined), 20)],
      [
        'threw',
        () =>
          ({
            record: async () => {
              throw new Error('recorder broke');
            },
          }) as unknown as RefusalAuditRecorder,
      ],
    ];

    it.each(cases)('capture %s', async (_label, build) => {
      const filter = new RefusalAuditExceptionFilter(silentLogger() as unknown as Logger, build());
      const exception = marked();
      const expected = platformResponse(exception);

      const response = run(filter, exception);
      await until(() => response.json.mock.calls.length > 0);
      // Give any stray second write a chance to happen before counting.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(response.status).toHaveBeenCalledTimes(1);
      expect(response.json).toHaveBeenCalledTimes(1);
      expect(response.status).toHaveBeenCalledWith(403);
      expect(expected.status).toBe(403);
      expect(withoutTimestamp(response.json.mock.calls[0]![0])).toEqual(expected.body);
      expect(expected.body).toMatchObject({
        code: 'TENANT_MISMATCH',
        correlationId: 'COR_FILTER_1',
      });
    });
  });

  it('holds the refusal only until the capture settles, never longer than its bound', async () => {
    const filter = new RefusalAuditExceptionFilter(
      silentLogger() as unknown as Logger,
      recorderWith(() => new Promise<typeof COUNTED>(() => undefined), 60),
    );
    const started = Date.now();

    const response = run(filter, marked());
    expect(response.json).not.toHaveBeenCalled();

    await until(() => response.json.mock.calls.length > 0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('logs the refusal through the platform filter exactly once', async () => {
    const logger = silentLogger();
    const filter = new RefusalAuditExceptionFilter(
      logger as unknown as Logger,
      recorderWith(async () => COUNTED),
    );

    const response = run(filter, marked());
    await until(() => response.json.mock.calls.length > 0);

    const denials = logger.warn.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.startsWith('Access denied'),
    );
    expect(denials).toHaveLength(1);
  });
});
