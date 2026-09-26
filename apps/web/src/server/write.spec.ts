/**
 * @jest-environment node
 */
import type { z } from 'zod';

import { mapProblemToFields, writeThroughGateway, type FieldMapping } from './write';
import type { WebSession } from './session';

/**
 * Writing through the gateway: what reaches the wire, and what comes back
 * onto a field.
 *
 * Server code, so `node` rather than the portal's jsdom default — this is
 * about `fetch`, `Response` and headers, not about a DOM.
 */

process.env.API_GATEWAY_URL ??= 'http://gateway.test:3000';
process.env.OIDC_ISSUER_URL ??= 'http://keycloak.test/realms/rasta';
process.env.OIDC_CLIENT_ID ??= 'rasta-web';
process.env.WEB_PUBLIC_ORIGIN ??= 'http://localhost:3200';
process.env.WEB_SESSION_SECRET ??= 'a-secret-that-is-long-enough-to-be-a-key';

const session = { accessToken: 'access-token-value' } as WebSession;

type Field = 'hours' | 'periodEnd';

const mapping: FieldMapping<Field> = {
  paths: { hours: 'hours', periodEnd: 'periodEnd' },
  messages: { 'Record at least one of hours or kilometres': 'یکی از دو مقدار لازم است' },
};

/**
 * A stand-in for a Zod schema, so this file needs no schema of its own.
 *
 * Typed as `z.ZodTypeAny` through a cast rather than with `any`: the two
 * methods `writeThroughGateway` uses are `safeParse`'s two outcomes, and
 * naming the cast once here keeps the call sites honest.
 */
const schema = {
  safeParse: (value: unknown) =>
    typeof value === 'object' && value !== null && 'id' in value
      ? { success: true as const, data: value as { id: string } }
      : { success: false as const, error: new Error('shape') },
} as unknown as z.ZodTypeAny;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function call(fetchImpl: typeof fetch) {
  return writeThroughGateway(session, {
    path: '/v1/usage-records',
    body: { assetId: 'AST_1' },
    submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
    schema,
    mapping,
    fetchImpl,
  });
}

describe('what reaches the gateway', () => {
  it('sends the submission id as Idempotency-Key, with the bearer token and a correlation id', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'USG_1' }));
    await call(fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe('http://gateway.test:3000/v1/usage-records');
    expect(init.method).toBe('POST');
    expect(headers['idempotency-key']).toBe('sub_AAAAAAAAAAAAAAAAAAAA');
    expect(headers.authorization).toBe('Bearer access-token-value');
    expect(headers['x-correlation-id']).toEqual(expect.any(String));
  });

  it('defaults to POST when no method is given, so the first caller never had to say it', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'USG_1' }));
    await call(fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST');
  });

  it('sends the method a caller states, for an update rather than a create', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { id: 'DRV_1' }));
    await writeThroughGateway(session, {
      path: '/v1/drivers/DRV_1',
      method: 'PATCH',
      body: { employeeNo: 'EMP-1' },
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      schema,
      mapping,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('PATCH');
  });

  it('sends the same key on a retry, which is what makes a retry one record', async () => {
    // The double-submit case, at the level this module controls: the id comes
    // from the caller, so two attempts at one submission carry one key and the
    // service — which is the authority — sees them as the same submission.
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'USG_1' }));
    await call(fetchImpl as unknown as typeof fetch);
    await call(fetchImpl as unknown as typeof fetch);

    const keys = fetchImpl.mock.calls.map(
      (args) =>
        ((args as unknown as [string, RequestInit])[1].headers as Record<string, string>)[
          'idempotency-key'
        ],
    );
    expect(keys).toEqual(['sub_AAAAAAAAAAAAAAAAAAAA', 'sub_AAAAAAAAAAAAAAAAAAAA']);
  });

  it('refuses to call anything but the gateway', async () => {
    const fetchImpl = jest.fn();
    await expect(
      writeThroughGateway(session, {
        path: 'http://localhost:3104/v1/usage-records',
        body: {},
        submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
        schema,
        mapping,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/only call the API Gateway/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('what comes back', () => {
  it('returns the created record, parsed by the schema', async () => {
    const result = await call((async () =>
      jsonResponse(201, { id: 'USG_1' })) as unknown as typeof fetch);
    expect(result).toMatchObject({ kind: 'CREATED', data: { id: 'USG_1' } });
  });

  it('puts a 400 detail back on the field that caused it', async () => {
    const result = await call((async () =>
      jsonResponse(400, {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: [{ path: 'periodEnd', message: 'periodEnd must be after periodStart' }],
      })) as unknown as typeof fetch);

    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { periodEnd: 'periodEnd must be after periodStart' },
      message: null,
    });
  });

  it('translates a message it knows and keeps one it does not', async () => {
    const known = await call((async () =>
      jsonResponse(400, {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: [{ path: 'hours', message: 'Record at least one of hours or kilometres' }],
      })) as unknown as typeof fetch);
    expect(known).toMatchObject({ fieldErrors: { hours: 'یکی از دو مقدار لازم است' } });

    // A message this portal has never seen is shown as it arrived. The
    // service's sentence is the truth; a stale dictionary is not.
    const unknown = await call((async () =>
      jsonResponse(400, {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: [{ path: 'hours', message: 'A rule invented after this portal shipped' }],
      })) as unknown as typeof fetch);
    expect(unknown).toMatchObject({
      fieldErrors: { hours: 'A rule invented after this portal shipped' },
    });
  });

  it('keeps a 422 business rule as a message when no field is named', async () => {
    const result = await call((async () =>
      jsonResponse(422, {
        code: 'BUSINESS_RULE_VIOLATION',
        message: 'Usage cannot be recorded for a period in the future.',
      })) as unknown as typeof fetch);

    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'Usage cannot be recorded for a period in the future.',
    });
  });

  it('separates a refusal from an absence', async () => {
    const forbidden = await call((async () =>
      jsonResponse(403, { code: 'FORBIDDEN', message: 'no' })) as unknown as typeof fetch);
    const missing = await call((async () =>
      jsonResponse(404, { code: 'NOT_FOUND', message: 'no' })) as unknown as typeof fetch);

    expect(forbidden.kind).toBe('FORBIDDEN');
    expect(missing.kind).toBe('NOT_FOUND');
  });

  it('never reads a 5xx body, and reports the status with its correlation id', async () => {
    // A 500 body can carry anything, including a tenant's data. The screen
    // gets a status and an id support can trace, and nothing else.
    const result = await call((async () =>
      jsonResponse(500, {
        code: 'INTERNAL_ERROR',
        message: 'stack trace here',
      })) as unknown as typeof fetch);

    expect(result).toMatchObject({ kind: 'UNAVAILABLE', status: 500 });
    expect(JSON.stringify(result)).not.toContain('stack trace here');
  });

  it('treats a success it cannot read as unconfirmed, never as a failure', async () => {
    // A 2xx: the write happened; its answer is simply not one to show.
    const result = await call((async () =>
      jsonResponse(201, { unexpected: true })) as unknown as typeof fetch);
    expect(result.kind).toBe('UNKNOWN_OUTCOME');
  });

  it('survives a 4xx that is not JSON at all', async () => {
    const result = await call(
      (async () =>
        new Response('<html>gateway</html>', {
          status: 400,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    );

    // No problem body to map, so it is an outage to the person rather than a
    // silent success or a crash.
    expect(result).toMatchObject({ kind: 'UNAVAILABLE', status: 400 });
  });
});

describe('mapProblemToFields', () => {
  it('keeps the first problem per field', () => {
    const mapped = mapProblemToFields(
      {
        code: 'VALIDATION_FAILED',
        message: 'no',
        details: [
          { path: 'hours', message: 'first' },
          { path: 'hours', message: 'second' },
        ],
      },
      mapping,
    );
    expect(mapped.fieldErrors.hours).toBe('first');
  });

  it('surfaces a detail for a path no field owns rather than dropping it', () => {
    const mapped = mapProblemToFields(
      {
        code: 'VALIDATION_FAILED',
        message: 'no',
        details: [{ path: 'headers.idempotency-key', message: 'required' }],
      },
      mapping,
    );
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.message).toBe('required');
  });
});

/**
 * A write that was sent but not answered is not a write that failed (Codex
 * post-merge review of #106): the service may have committed, and a person
 * told "nothing was saved" retries it.
 */
describe('sent, but not confirmed', () => {
  const rejecting = (error: unknown) =>
    (async () => {
      throw error;
    }) as unknown as typeof fetch;
  const socket = (code: string) => new TypeError('fetch failed', { cause: { code } });

  it.each([
    ['a connection reset after the request went out', socket('ECONNRESET')],
    ['the socket closing mid-response', socket('UND_ERR_SOCKET')],
    ['this portal’s own deadline', new DOMException('The operation was aborted.', 'TimeoutError')],
    ['a rejection with no cause at all', new TypeError('fetch failed')],
  ])('is UNKNOWN_OUTCOME for %s', async (_label, error) => {
    const result = await call(rejecting(error));
    expect(result).toEqual({ kind: 'UNKNOWN_OUTCOME', correlationId: expect.any(String) });
  });

  it.each([
    ['a refused connection', 'ECONNREFUSED'],
    ['an unknown host', 'ENOTFOUND'],
    ['a connect timeout', 'UND_ERR_CONNECT_TIMEOUT'],
  ])('is still UNAVAILABLE for %s: nothing was sent', async (_label, code) => {
    const result = await call(rejecting(socket(code)));
    expect(result).toMatchObject({ kind: 'UNAVAILABLE', status: 503 });
  });

  it('is UNKNOWN_OUTCOME for a 2xx whose body does not parse', async () => {
    const result = await call(
      (async () =>
        new Response('{"id": "USG_1"', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );
    expect(result.kind).toBe('UNKNOWN_OUTCOME');
  });

  it('is UNKNOWN_OUTCOME when the gateway forwarded it and its upstream timed out (504)', async () => {
    const result = await call((async () =>
      jsonResponse(504, { code: 'UPSTREAM_TIMEOUT', message: 'late' })) as unknown as typeof fetch);
    expect(result.kind).toBe('UNKNOWN_OUTCOME');
  });

  it('is still UNAVAILABLE when the gateway refused to forward it (503)', async () => {
    const result = await call((async () =>
      jsonResponse(503, {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'open',
      })) as unknown as typeof fetch);
    expect(result).toMatchObject({ kind: 'UNAVAILABLE', status: 503 });
  });
});
