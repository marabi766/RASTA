import { withRedirectProbe } from '@rasta/testing';
import { AllExceptionsFilter, RastaError, isRastaError } from '@rasta/nest-common';
import {
  EconomicClient,
  fundsOf,
  idempotencyKeyFor,
  OBLIGATION_LOOKUP_PAGES,
  ObligationLookupIncomplete,
  type ObligationFunds,
} from './economic.client';
import type { MarketplaceEnv } from '../config/env';

/**
 * The client that moves money (ADR-040).
 *
 * Two properties are worth testing without a running economic-service, because
 * both are invisible in a happy-path integration run and both are financial:
 *
 * - **the idempotency key is derived from identity**, so a retry replays
 *   rather than placing a second hold;
 * - **the tenant is inside the signature**, so a leaked token is worth one
 *   organization on one service (ADR-035).
 */

const ENV = {
  ECONOMIC_SERVICE_URL: 'http://economic.test',
  ECONOMIC_REQUEST_TIMEOUT_MS: 5_000,
} as MarketplaceEnv;

/** Records what was minted, so the test can assert on the tenant and target. */
function recordingTokens() {
  const issued: { caller: string; target: string; purpose: string; org?: string }[] = [];
  return {
    issued,
    service: {
      issue: async (caller: string, target: string, purpose: string, org?: string) => {
        issued.push({ caller, target, purpose, ...(org ? { org } : {}) });
        return 'minted-token';
      },
    },
  };
}

/** A fetch stub that records the request and answers with `response`. */
function stubFetch(response: { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body?: unknown }[] = [];

  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      ...(init.body ? { body: JSON.parse(init.body as string) as unknown } : {}),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => JSON.stringify(response.body),
    } as Response;
  };

  return { calls, impl };
}

describe('idempotency keys are derived from the order, never from a clock', () => {
  it('produces the same key every time for the same order and operation', () => {
    // The property the whole retry story rests on: a Temporal retry, or a
    // replay after a crash, sends the *same* key, so economic-service returns
    // the original response instead of placing a second hold.
    expect(idempotencyKeyFor.hold('ORD_1')).toBe(idempotencyKeyFor.hold('ORD_1'));
    expect(idempotencyKeyFor.settle('ORD_1')).toBe(idempotencyKeyFor.settle('ORD_1'));
  });

  it('gives each operation on one order its own key', () => {
    const keys = [
      idempotencyKeyFor.hold('ORD_1'),
      idempotencyKeyFor.authorise('ORD_1'),
      idempotencyKeyFor.settle('ORD_1'),
      idempotencyKeyFor.refund('ORD_1'),
      idempotencyKeyFor.cancel('ORD_1'),
      idempotencyKeyFor.dispute('ORD_1', 'DSP_1'),
      idempotencyKeyFor.resolveDispute('ORD_1', 'DSP_1'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives a second dispute on the same order its own key', () => {
    // One key per order made the second dispute a replay of the first: its
    // stored response came back and economic-service never saw a dispute.
    expect(idempotencyKeyFor.dispute('ORD_1', 'DSP_2')).not.toBe(
      idempotencyKeyFor.dispute('ORD_1', 'DSP_1'),
    );
    expect(idempotencyKeyFor.resolveDispute('ORD_1', 'DSP_2')).not.toBe(
      idempotencyKeyFor.resolveDispute('ORD_1', 'DSP_1'),
    );
  });

  it('gives two orders different keys for the same operation', () => {
    expect(idempotencyKeyFor.hold('ORD_1')).not.toBe(idempotencyKeyFor.hold('ORD_2'));
  });

  it('names the order, so an operator can trace a key back to it', () => {
    expect(idempotencyKeyFor.hold('ORD_1')).toContain('ORD_1');
  });
});

describe('creating the obligation', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('holds the funds in the same call that creates the obligation', async () => {
    // Two calls would leave a window in which the buyer can spend what they
    // have just committed (docs/10 § 10.5).
    const { calls, impl } = stubFetch({ status: 201, body: { id: 'TXN_1' } });
    globalThis.fetch = impl as typeof fetch;
    const tokens = recordingTokens();

    const client = new EconomicClient(ENV, tokens.service as never);
    await client.createObligation({
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-BUYER',
      supplierOrganizationId: 'ORG-SUPPLIER',
      totalAmountMinor: 900_000n,
      currency: 'IRR',
      correlationId: 'corr-1',
    });

    const request = calls[0]!;
    const body = request.body as Record<string, unknown>;

    expect(body.holdFunds).toBe(true);
    expect(body.transactionType).toBe('MARKETPLACE_ORDER');
    expect(body.counterpartyOrganizationId).toBe('ORG-SUPPLIER');
    // A string in minor units, never a JSON number (ADR-022).
    expect(body.grossAmountMinor).toBe('900000');
    // The order is named as the source, so an auditor can walk from a ledger
    // entry back to the purchase.
    expect(body.sourceReference).toBe('ORD_1');
    // Under the key the recovery's lookup asks for exactly (`findObligations`).
    expect(body.sourceType).toBe('ORDER');
    expect(request.headers['idempotency-key']).toBe(idempotencyKeyFor.hold('ORD_1'));
  });

  it('signs the buyer’s organization into the token and sends no tenant header', async () => {
    const { calls, impl } = stubFetch({ status: 201, body: { id: 'TXN_1' } });
    globalThis.fetch = impl as typeof fetch;
    const tokens = recordingTokens();

    const client = new EconomicClient(ENV, tokens.service as never);
    await client.createObligation({
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-BUYER',
      supplierOrganizationId: 'ORG-SUPPLIER',
      totalAmountMinor: 1n,
      currency: 'IRR',
      correlationId: 'corr-1',
    });

    expect(tokens.issued[0]).toEqual({
      caller: 'marketplace-service',
      target: 'economic-service',
      purpose: 'SERVICE',
      org: 'ORG-BUYER',
    });

    // ADR-035: the tenant is inside the signature. Sending the header as well
    // would add no authority and one more way for the two to disagree.
    expect(calls[0]!.headers['x-organization-id']).toBeUndefined();
    expect(calls[0]!.headers['x-internal-token']).toBe('minted-token');
    // And no user bearer token: this is a service acting, not a person.
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });
});

describe('a refusal keeps economic-service’s own error code', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('re-raises INSUFFICIENT_BALANCE as itself, not as an internal error', async () => {
    // So an empty wallet reaches the buyer as an empty wallet. Collapsing it to
    // a generic upstream failure would tell them to retry something that will
    // never succeed.
    const { impl } = stubFetch({
      status: 422,
      body: { code: 'INSUFFICIENT_BALANCE', message: 'Not enough available balance' },
    });
    globalThis.fetch = impl as typeof fetch;

    const client = new EconomicClient(ENV, recordingTokens().service as never);

    await expect(
      client.createObligation({
        orderId: 'ORD_1',
        buyerOrganizationId: 'ORG-BUYER',
        supplierOrganizationId: 'ORG-SUPPLIER',
        totalAmountMinor: 1n,
        currency: 'IRR',
        correlationId: 'corr-1',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));
  });

  it('reads the body the platform’s exception filter writes, not a shape of its own', async () => {
    // The bodies above are written by hand, and once had a shape no service
    // sends (`{ error: { code } }`): every refusal came back
    // UPSTREAM_UNAVAILABLE, and a retry refused for the transaction's state
    // never reached the obligation read that answers it (D-053, review of
    // #287). This one comes from the filter economic-service runs.
    let sent: unknown;
    const response = {
      status: () => response,
      json: (body: unknown) => {
        sent = body;
      },
      setHeader: () => undefined,
    };
    const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
    new AllExceptionsFilter(quiet as never).catch(
      RastaError.invalidStateTransition('Transaction', 'PENDING_SETTLEMENT', 'PENDING_SETTLEMENT'),
      { switchToHttp: () => ({ getResponse: () => response }) } as never,
    );
    const { impl } = stubFetch({ status: 409, body: sent });
    globalThis.fetch = impl as typeof fetch;

    const client = new EconomicClient(ENV, recordingTokens().service as never);

    await expect(
      client.authoriseSettlement({
        orderId: 'ORD_1',
        transactionId: 'TXN_1',
        buyerOrganizationId: 'ORG-BUYER',
        correlationId: 'corr-1',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION', status: 409 }));
  });

  it('falls back to an upstream code when the body names one this platform does not have', async () => {
    // A code the platform does not define must not be trusted into a status
    // lookup that would be undefined.
    const { impl } = stubFetch({
      status: 500,
      body: { code: 'SOMETHING_ELSE', message: 'unknown' },
    });
    globalThis.fetch = impl as typeof fetch;

    const client = new EconomicClient(ENV, recordingTokens().service as never);

    try {
      await client.settle({
        orderId: 'ORD_1',
        transactionId: 'TXN_1',
        buyerOrganizationId: 'ORG-BUYER',
        correlationId: 'corr-1',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
      expect((error as { status: number }).status).toBeGreaterThanOrEqual(500);
    }
  });

  it('reports an unreachable service without leaking the request', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3112');
    }) as typeof fetch;

    const client = new EconomicClient(ENV, recordingTokens().service as never);

    try {
      await client.refund({
        orderId: 'ORD_1',
        transactionId: 'TXN_1',
        buyerOrganizationId: 'ORG-BUYER',
        reason: 'cancelled',
        correlationId: 'corr-1',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
      // The message says a service is unavailable and nothing about the token
      // or the URL, either of which can carry a credential (S-09).
      expect((error as Error).message).not.toContain('minted-token');
      expect((error as Error).message).not.toContain('3112');
    }
  });
});

describe('each command reaches the endpoint it names', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it.each([
    ['authoriseSettlement', '/v1/transactions/TXN_1/authorise-settlement'],
    ['settle', '/v1/settlements'],
    ['refund', '/v1/transactions/TXN_1/refund'],
    ['cancel', '/v1/transactions/TXN_1/cancel'],
    ['dispute', '/v1/transactions/TXN_1/dispute'],
    ['resolveDispute', '/v1/transactions/TXN_1/resolve-dispute'],
  ])('%s posts to %s', async (method, path) => {
    const { calls, impl } = stubFetch({ status: 200, body: { settlementId: 'STL_1' } });
    globalThis.fetch = impl as typeof fetch;

    const client = new EconomicClient(ENV, recordingTokens().service as never) as unknown as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;

    await client[method]!({
      orderId: 'ORD_1',
      disputeId: 'DSP_1',
      transactionId: 'TXN_1',
      buyerOrganizationId: 'ORG-BUYER',
      reason: 'a reason long enough to pass',
      resolution: 'a resolution long enough to pass',
      correlationId: 'corr-1',
    });

    expect(calls[0]!.url).toBe(`http://economic.test${path}`);
    expect(calls[0]!.headers['x-correlation-id']).toBe('corr-1');
  });
});

describe('a resolution names economic-service’s dispute (Codex on #318 round 2, N1)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const resolve = async (economicDisputeId?: string) => {
    const { calls, impl } = stubFetch({ status: 200, body: { id: 'TXN_1' } });
    globalThis.fetch = impl as typeof fetch;
    await new EconomicClient(ENV, recordingTokens().service as never).resolveDispute({
      orderId: 'ORD_1',
      disputeId: 'DSP_1',
      ...(economicDisputeId === undefined ? {} : { economicDisputeId }),
      transactionId: 'TXN_1',
      buyerOrganizationId: 'ORG-BUYER',
      resolution: 'the supplier showed a signed delivery note',
      correlationId: 'corr-1',
    });
    return calls[0]!;
  };

  it('sends the identity as the body’s disputeId, under the order dispute’s own key', async () => {
    const request = await resolve('TXD_1');
    expect(request.body).toEqual({
      resolution: 'the supplier showed a signed delivery note',
      disputeId: 'TXD_1',
    });
    expect(request.headers['idempotency-key']).toBe(
      idempotencyKeyFor.resolveDispute('ORD_1', 'DSP_1'),
    );
  });

  it('sends no disputeId without one, as before', async () => {
    expect((await resolve()).body).toEqual({
      resolution: 'the supplier showed a signed delivery note',
    });
  });
});

describe('reading the order’s obligation back (D-053)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const obligation = {
    id: 'TXN_1',
    organizationId: 'ORG-BUYER',
    counterpartyOrganizationId: 'ORG-SUPPLIER',
    transactionType: 'MARKETPLACE_ORDER',
    status: 'PENDING_SETTLEMENT',
    grossAmountMinor: '500000',
    commissionAmountMinor: '0',
    netAmountMinor: '0',
    currency: 'IRR',
    sourceReference: 'ORD_1',
    disputedAt: null,
    disputeReason: null,
    settlement: null,
  };

  const read = (client: EconomicClient) =>
    client.readObligation({
      orderId: 'ORD_1',
      transactionId: 'TXN_1',
      buyerOrganizationId: 'ORG-BUYER',
      correlationId: 'corr-1',
    });

  it('reads the one transaction as its payer, with no idempotency key', async () => {
    const { calls, impl } = stubFetch({ status: 200, body: obligation });
    globalThis.fetch = impl as typeof fetch;
    const tokens = recordingTokens();

    await expect(read(new EconomicClient(ENV, tokens.service as never))).resolves.toEqual(
      obligation,
    );

    expect(calls[0]!.url).toBe('http://economic.test/v1/transactions/TXN_1');
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
    expect(tokens.issued).toEqual([
      {
        caller: 'marketplace-service',
        target: 'economic-service',
        purpose: 'SERVICE',
        org: 'ORG-BUYER',
      },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another order’s obligation', { sourceReference: 'ORD_2' }],
    ['a transaction that is not an order obligation', { transactionType: 'CONTRACT_MILESTONE' }],
    ['another payer’s transaction', { organizationId: 'ORG-OTHER' }],
    ['another transaction than the one asked for', { id: 'TXN_2' }],
  ])('proves nothing about %s', async (_label, differs) => {
    const { impl } = stubFetch({ status: 200, body: { ...obligation, ...differs } });
    globalThis.fetch = impl as typeof fetch;

    await expect(read(new EconomicClient(ENV, recordingTokens().service as never))).resolves.toBe(
      null,
    );
  });
});

describe('finding the order’s obligation by its exact key (review of #334 round 2, F2)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    organizationId: 'ORG-BUYER',
    counterpartyOrganizationId: 'ORG-SUPPLIER',
    transactionType: 'MARKETPLACE_ORDER',
    status: 'HELD',
    grossAmountMinor: '500000',
    commissionAmountMinor: '0',
    netAmountMinor: '500000',
    currency: 'IRR',
    sourceType: 'ORDER',
    sourceReference: 'ORD_1',
    ...overrides,
  });

  /** Answers each GET with the next page; the last one repeats. */
  function pagedFetch(pages: { items: unknown[]; nextCursor: string | null; hasMore: boolean }[]) {
    const urls: URL[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(new URL(url));
      const page = pages[Math.min(urls.length, pages.length) - 1];
      return { ok: true, status: 200, text: async () => JSON.stringify(page) } as Response;
    }) as typeof fetch;
    return urls;
  }

  const find = () =>
    new EconomicClient(ENV, recordingTokens().service as never).findObligations({
      orderId: 'ORD_1',
      buyerOrganizationId: 'ORG-BUYER',
      correlationId: 'corr-1',
    });

  it('asks for exactly ORDER/<order id> as MARKETPLACE_ORDER, the largest page', async () => {
    const urls = pagedFetch([{ items: [row('TXN_1')], nextCursor: null, hasMore: false }]);

    await expect(find()).resolves.toEqual([row('TXN_1')]);

    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe('/v1/transactions');
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      transactionType: 'MARKETPLACE_ORDER',
      sourceType: 'ORDER',
      sourceReference: 'ORD_1',
      limit: '100',
    });
  });

  it('reads every page, following the cursor, before it answers', async () => {
    const urls = pagedFetch([
      {
        items: [row('TXN_A', { counterpartyOrganizationId: 'ORG-OTHER' })],
        nextCursor: 'TXN_A',
        hasMore: true,
      },
      { items: [row('TXN_B')], nextCursor: null, hasMore: false },
    ]);

    const found = await find();

    expect(found.map((transaction) => transaction.id)).toEqual(['TXN_A', 'TXN_B']);
    expect(urls.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'TXN_A']);
  });

  it('keeps only rows under the exact key, whatever the answer carries', async () => {
    pagedFetch([
      {
        items: [
          row('TXN_TYPE', { sourceType: 'ORDER_UNCONFIRMED' }),
          row('TXN_CASE', { sourceType: 'order' }),
          row('TXN_REF', { sourceReference: 'ORD_2' }),
          row('TXN_KIND', { transactionType: 'LOGISTICS' }),
          row('TXN_OWN'),
        ],
        nextCursor: null,
        hasMore: false,
      },
    ]);

    await expect(find()).resolves.toEqual([row('TXN_OWN')]);
  });

  it(`gives up on an answer that has not ended after ${OBLIGATION_LOOKUP_PAGES} pages`, async () => {
    const urls = pagedFetch([{ items: [], nextCursor: 'more', hasMore: true }]);

    await expect(find()).rejects.toBeInstanceOf(ObligationLookupIncomplete);
    expect(urls).toHaveLength(OBLIGATION_LOOKUP_PAGES);
  });

  it('gives up on more pages announced with no cursor to them', async () => {
    const urls = pagedFetch([{ items: [row('TXN_1')], nextCursor: null, hasMore: true }]);

    await expect(find()).rejects.toBeInstanceOf(ObligationLookupIncomplete);
    expect(urls).toHaveLength(1);
  });
});

describe('what an obligation’s status says of its funds (review of #334 round 2, F1)', () => {
  // Every status economic-service has (its TransactionStatus enum), and ones it does not.
  it.each<[string, ObligationFunds]>([
    ['HELD', 'HELD'],
    ['CREATED', 'NEVER_HELD'],
    ['PENDING_SETTLEMENT', 'UNPROVEN'],
    ['DISPUTED', 'UNPROVEN'],
    ['SETTLED', 'PAID_OUT'],
    ['REFUNDED', 'RETURNED'],
    ['CANCELLED', 'NEVER_HELD'],
    ['FAILED', 'NEVER_HELD'],
    ['A_STATUS_ADDED_LATER', 'UNPROVEN'],
    ['held', 'UNPROVEN'],
  ])('%s → %s', (status, funds) => {
    expect(fundsOf(status)).toBe(funds);
  });
});

it('retries a committed hold whose response became a redirect with the same idempotency key and body', async () => {
  const transaction = { id: 'TXN_COMMITTED', status: 'HELD', organizationId: 'ORG_BUYER' };
  const committed = new Map<string, string>();
  const receivedBodies: string[] = [];
  let writes = 0;
  await withRedirectProbe(
    {
      body: transaction,
      onRequest: (request, body) => {
        if (request.method !== 'POST') return;
        // The HTTP owner commits the operation before sending the redirect response.
        const key = String(request.headers['idempotency-key']);
        receivedBodies.push(body);
        if (!committed.has(key)) {
          committed.set(key, body);
          writes += 1;
        }
      },
    },
    async (probe) => {
      const original = globalThis.fetch;
      globalThis.fetch = probe.fetch;
      try {
        const client = new EconomicClient(
          { ...ENV, ECONOMIC_SERVICE_URL: probe.baseUrl },
          recordingTokens().service as never,
        );
        const input = {
          orderId: 'ORD_1',
          buyerOrganizationId: 'ORG_BUYER',
          supplierOrganizationId: 'ORG_SUPPLIER',
          totalAmountMinor: 10n,
          currency: 'IRR',
          correlationId: 'corr-1',
        };
        await expect(client.createObligation(input)).rejects.toMatchObject({
          code: 'UPSTREAM_UNAVAILABLE',
        });
        expect(writes).toBe(1);
        expect(probe.sent).toHaveLength(1);
        expect(probe.target).toEqual([]);
        probe.recover();
        await expect(client.createObligation(input)).resolves.toEqual(transaction);
        expect(writes).toBe(1);
        expect([...committed.keys()]).toEqual([idempotencyKeyFor.hold('ORD_1')]);
        expect(receivedBodies).toHaveLength(2);
        expect(receivedBodies[1]).toBe(receivedBodies[0]);
        expect(committed.get(idempotencyKeyFor.hold('ORD_1'))).toBe(receivedBodies[0]);
        expect(probe.sent.map((request) => request.headers['idempotency-key'])).toEqual([
          idempotencyKeyFor.hold('ORD_1'),
          idempotencyKeyFor.hold('ORD_1'),
        ]);
        expect(probe.target).toEqual([]);
      } finally {
        globalThis.fetch = original;
      }
    },
  );
});
