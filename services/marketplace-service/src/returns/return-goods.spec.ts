import { RastaError } from '@rasta/nest-common';
import { ReturnGoodsClient } from './return-goods';

/**
 * The question marketplace asks inventory before cancelling an AUTHORIZED return, and the
 * withdrawal it asks for before releasing a dispatch reservation (Q-133 (9)): only a well-formed
 * 200 about the very request (and reservation) asked is an answer; everything else refuses.
 */

const RESERVATION = 'RDR_01JABCDEFGHJKMNPQRSTVWXYZ0';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A client whose inventory answers `status` with `body`, recording what it was sent. */
function clientAnswering(status: number, body: unknown, sent: Sent[] = []) {
  const issue = jest.fn(async () => 'signed-token');
  const client = new ReturnGoodsClient({
    baseUrl: 'http://inventory.test/',
    timeoutMs: 1000,
    tokens: { issue },
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method as string,
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
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

const NONE = { returnRequestId: 'RET_1', returnShipment: null };
const SHIPPED = { returnRequestId: 'RET_1', returnShipment: { id: 'RSP_1', status: 'IN_TRANSIT' } };
const WITHDRAWN = {
  outcome: 'WITHDRAWN',
  returnRequestId: 'RET_1',
  reservationId: RESERVATION,
  withdrawnAt: '2026-10-17T10:00:00.000Z',
  returnShipment: null,
};
const DISPATCHED = {
  outcome: 'DISPATCHED',
  returnRequestId: 'RET_1',
  reservationId: RESERVATION,
  withdrawnAt: null,
  returnShipment: { id: 'RSP_1', status: 'RECEIVED' },
};

describe('ReturnGoodsClient', () => {
  it('asks for the shipment with a token minted for inventory and signed for the supplier, alone', async () => {
    const { client, issue, sent } = clientAnswering(200, NONE);

    await expect(client.shipmentOf('ORG_SUPPLIER', 'RET_1')).resolves.toBeNull();

    expect(issue).toHaveBeenCalledWith(
      'marketplace-service',
      'inventory-service',
      'SERVICE',
      'ORG_SUPPLIER',
    );
    expect(sent).toEqual([
      {
        url: 'http://inventory.test/v1/internal/return-requests/RET_1/return-shipment',
        method: 'GET',
        headers: expect.objectContaining({ 'x-internal-token': 'signed-token' }),
        body: undefined,
      },
    ]);
    expect(sent[0]?.headers).not.toHaveProperty('authorization');
  });

  it('names the shipment inventory holds', async () => {
    await expect(
      clientAnswering(200, SHIPPED).client.shipmentOf('ORG_SUPPLIER', 'RET_1'),
    ).resolves.toEqual({ id: 'RSP_1', status: 'IN_TRANSIT' });
  });

  it('withdraws with a POST naming the reservation, and reads both outcomes', async () => {
    const { client, sent } = clientAnswering(200, WITHDRAWN);
    await expect(client.withdraw('ORG_SUPPLIER', 'RET_1', RESERVATION)).resolves.toEqual({
      outcome: 'WITHDRAWN',
      withdrawnAt: new Date('2026-10-17T10:00:00.000Z'),
    });
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      [
        'POST',
        'http://inventory.test/v1/internal/return-requests/RET_1/dispatch-withdrawal',
        JSON.stringify({ reservationId: RESERVATION }),
      ],
    ]);

    await expect(
      clientAnswering(200, DISPATCHED).client.withdraw('ORG_SUPPLIER', 'RET_1', RESERVATION),
    ).resolves.toEqual({
      outcome: 'DISPATCHED',
      returnShipment: { id: 'RSP_1', status: 'RECEIVED' },
    });
  });

  it.each([
    [
      'a 404 (a route missing in a rolling deploy)',
      404,
      { code: 'NOT_FOUND', message: 'Cannot GET' },
    ],
    ['a 403 (a misconfigured allowlist)', 403, { code: 'FORBIDDEN', message: 'x' }],
    ['a 409', 409, { code: 'CONFLICT', message: 'x' }],
    ['a 500', 500, { code: 'INTERNAL_ERROR', message: 'x' }],
    ['a body that is not JSON', 200, 'not json'],
    ['an answer without the shipment field', 200, { returnRequestId: 'RET_1' }],
    ['an answer about another request', 200, { ...NONE, returnRequestId: 'RET_2' }],
    ['a body larger than the contract', 200, { ...NONE, padding: 'x'.repeat(5000) }],
  ])(
    'a shipment question fails closed on %s: UPSTREAM_UNAVAILABLE, never "none"',
    async (_n, status, body) => {
      expect(await codeOf(clientAnswering(status, body).client.shipmentOf('O', 'RET_1'))).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
    },
  );

  it.each([
    ['another reservation', { ...WITHDRAWN, reservationId: 'RDR_01JABCDEFGHJKMNPQRSTVWXYZ1' }],
    ['another request', { ...WITHDRAWN, returnRequestId: 'RET_2' }],
    ['WITHDRAWN with no instant', { ...WITHDRAWN, withdrawnAt: null }],
    ['WITHDRAWN naming a shipment', { ...WITHDRAWN, returnShipment: { id: 'RSP_1', status: 'X' } }],
    ['DISPATCHED with no shipment', { ...DISPATCHED, returnShipment: null }],
    ['an outcome it does not know', { ...WITHDRAWN, outcome: 'RELEASED' }],
  ])('a withdrawal fails closed on an answer about %s', async (_n, body) => {
    expect(
      await codeOf(clientAnswering(200, body).client.withdraw('O', 'RET_1', RESERVATION)),
    ).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('fails closed on a transport error, and on a deadline as UPSTREAM_TIMEOUT, leaking no URL', async () => {
    const tokens = { issue: async () => 't' };
    const down = new ReturnGoodsClient({
      baseUrl: 'http://inventory.test',
      timeoutMs: 1000,
      tokens,
      fetch: (async () => {
        throw new Error('ECONNREFUSED http://inventory.test');
      }) as unknown as typeof fetch,
    });
    const refused = await down.shipmentOf('O', 'RET_1').catch((error: RastaError) => error);
    expect((refused as RastaError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(refused)).not.toContain('inventory.test');

    const silent = new ReturnGoodsClient({
      baseUrl: 'http://inventory.test',
      timeoutMs: 20,
      tokens,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        )) as unknown as typeof fetch,
    });
    const timedOut = await silent
      .withdraw('O', 'RET_1', RESERVATION)
      .catch((error: RastaError) => error);
    expect((timedOut as RastaError).code).toBe('UPSTREAM_TIMEOUT');
    expect(JSON.stringify(timedOut)).not.toContain('inventory.test');
  });
});
