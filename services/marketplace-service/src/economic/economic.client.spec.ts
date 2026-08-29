import { isRastaError } from '@rasta/nest-common';
import { EconomicClient, idempotencyKeyFor } from './economic.client';
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
      idempotencyKeyFor.dispute('ORD_1'),
      idempotencyKeyFor.resolveDispute('ORD_1'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
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
      body: { error: { code: 'INSUFFICIENT_BALANCE', message: 'Not enough available balance' } },
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

  it('falls back to an upstream code when the body names one this platform does not have', async () => {
    // A code the platform does not define must not be trusted into a status
    // lookup that would be undefined.
    const { impl } = stubFetch({
      status: 500,
      body: { error: { code: 'SOMETHING_ELSE', message: 'unknown' } },
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
