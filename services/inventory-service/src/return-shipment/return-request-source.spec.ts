import { RastaError } from '@rasta/nest-common';
import { ReturnRequestSourceClient, isReturnRequestNotFound } from './return-request-source';

const FACT = {
  returnRequestId: 'RET_1',
  orderId: 'ORD_1',
  buyerOrganizationId: 'ORG_BUYER',
  supplierOrganizationId: 'ORG_SUPPLIER',
  status: 'AUTHORIZED',
  lines: [{ orderLineId: 'OLN_A', productId: 'PRD_A', quantity: 3 }],
  dispatchReservedAt: null,
  partialDispatchAllowed: false,
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A client whose marketplace answers `status` with `body`, recording what it was sent. */
function clientAnswering(status: number, body: unknown, sent: Sent[] = []) {
  const issue = jest.fn(async () => 'signed-token');
  const client = new ReturnRequestSourceClient({
    baseUrl: 'http://marketplace.test/',
    timeoutMs: 1000,
    tokens: { issue },
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method as string,
        headers: init.headers as Record<string, string>,
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });
  return { client, issue, sent };
}

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: RastaError) => error.code,
  );

describe('ReturnRequestSourceClient', () => {
  it('reads the request with a token minted for marketplace and signed for the supplier', async () => {
    const { client, issue, sent } = clientAnswering(200, FACT);

    await expect(client.read('ORG_SUPPLIER', 'RET_1')).resolves.toEqual(FACT);

    expect(issue).toHaveBeenCalledWith(
      'inventory-service',
      'marketplace-service',
      'SERVICE',
      'ORG_SUPPLIER',
    );
    expect(sent).toEqual([
      {
        url: 'http://marketplace.test/v1/internal/returns/RET_1',
        method: 'GET',
        headers: expect.objectContaining({ 'x-internal-token': 'signed-token' }),
      },
    ]);
    // The token travels alone: no bearer header to be judged on instead.
    expect(sent[0]?.headers).not.toHaveProperty('authorization');
  });

  it('reserves with a POST to the reservation route', async () => {
    const { client, sent } = clientAnswering(200, { ...FACT, dispatchReservedAt: 'now' });

    await expect(client.reserve('ORG_SUPPLIER', 'RET_1')).resolves.toMatchObject({
      dispatchReservedAt: 'now',
    });
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['POST', 'http://marketplace.test/v1/internal/returns/RET_1/dispatch-reservation'],
    ]);
  });

  it('takes a 404 as absence only when marketplace itself names a return request', async () => {
    const own = { code: 'NOT_FOUND', message: 'ReturnRequest not found' };
    await expect(clientAnswering(404, own).client.read('O', 'RET_1')).resolves.toBeNull();
    await expect(clientAnswering(404, own).client.reserve('O', 'RET_1')).resolves.toBeNull();

    const route = { code: 'NOT_FOUND', message: 'Cannot GET /v1/internal/returns/RET_1' };
    expect(await codeOf(clientAnswering(404, route).client.read('O', 'RET_1'))).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
    expect(isReturnRequestNotFound({ code: 'NOT_FOUND', message: 'Order not found' })).toBe(false);
  });

  it('takes a 422 on the reservation as NOT_DISPATCHABLE, and on a read as no answer', async () => {
    const refused = { code: 'BUSINESS_RULE_VIOLATION', message: 'not AUTHORIZED' };
    await expect(clientAnswering(422, refused).client.reserve('O', 'RET_1')).resolves.toBe(
      'NOT_DISPATCHABLE',
    );
    expect(await codeOf(clientAnswering(422, refused).client.read('O', 'RET_1'))).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
    expect(
      await codeOf(
        clientAnswering(422, { code: 'VALIDATION_FAILED', message: 'x' }).client.reserve(
          'O',
          'RET_1',
        ),
      ),
    ).toBe('UPSTREAM_UNAVAILABLE');
  });

  it.each([
    ['a 403 (a misconfigured allowlist)', 403, { code: 'FORBIDDEN', message: 'x' }],
    ['a 409', 409, { code: 'OPTIMISTIC_LOCK_FAILED', message: 'x' }],
    ['a 500', 500, { code: 'INTERNAL_ERROR', message: 'x' }],
    ['a body that is not JSON', 200, 'not json'],
    ['an answer of the wrong shape', 200, { ...FACT, lines: [] }],
    ['an answer about another request', 200, { ...FACT, returnRequestId: 'RET_2' }],
  ])('fails closed on %s: UPSTREAM_UNAVAILABLE, never a yes', async (_name, status, body) => {
    expect(await codeOf(clientAnswering(status, body).client.read('O', 'RET_1'))).toBe(
      'UPSTREAM_UNAVAILABLE',
    );
  });

  it('fails closed on a transport error, and on a deadline as UPSTREAM_TIMEOUT', async () => {
    const tokens = { issue: async () => 't' };
    const down = new ReturnRequestSourceClient({
      baseUrl: 'http://marketplace.test',
      timeoutMs: 1000,
      tokens,
      fetch: (async () => {
        throw new Error('ECONNREFUSED http://marketplace.test');
      }) as unknown as typeof fetch,
    });
    expect(await codeOf(down.read('O', 'RET_1'))).toBe('UPSTREAM_UNAVAILABLE');

    const silent = new ReturnRequestSourceClient({
      baseUrl: 'http://marketplace.test',
      timeoutMs: 20,
      tokens,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        )) as unknown as typeof fetch,
    });
    const timedOut = await silent.read('O', 'RET_1').catch((error: RastaError) => error);
    expect(timedOut).toBeInstanceOf(RastaError);
    expect((timedOut as RastaError).code).toBe('UPSTREAM_TIMEOUT');
    // Nothing of the failure — no URL — reaches the error.
    expect(JSON.stringify(timedOut)).not.toContain('marketplace.test');
  });
});
