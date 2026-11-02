import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockActivityEnvironment } from '@temporalio/testing';
import { Context, CancelledFailure } from '@temporalio/activity';
import { InternalTokenService } from '@rasta/nest-common';
import { EconomicClient, ECONOMIC_RESPONSE_MAX_BYTES } from './economic.client';
import type { MarketplaceEnv } from '../config/env';

const INPUT = {
  orderId: 'ORD_BOUND',
  buyerOrganizationId: 'ORG_BUY',
  supplierOrganizationId: 'ORG_SELL',
  totalAmountMinor: 100n,
  currency: 'IRR',
  correlationId: 'corr-bound',
};
const tokens = { issue: async () => 'unused-local-token' } as unknown as InternalTokenService;
const client = (url: string, timeout = 50) =>
  new EconomicClient(
    { ECONOMIC_SERVICE_URL: url, ECONOMIC_REQUEST_TIMEOUT_MS: timeout } as MarketplaceEnv,
    tokens,
  );

afterEach(() => jest.restoreAllMocks());

it('headers then a stalled real body abort at the deadline, without a second financial request', async () => {
  let requests = 0;
  let closed: () => void = () => undefined;
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"id":');
    res.on('close', closed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    await expect(
      client(`http://127.0.0.1:${address.port}`, 1000).createObligation(INPUT),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await disconnected;
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([false, true])(
  'refuses an oversized body (content length present: %s), with fixed diagnostics',
  async (advertised) => {
    let signal: AbortSignal | undefined;
    let reader: jest.SpyInstance | undefined;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      const response = new Response(JSON.stringify('X'.repeat(ECONOMIC_RESPONSE_MAX_BYTES)), {
        status: 200,
        headers: advertised ? { 'content-length': String(ECONOMIC_RESPONSE_MAX_BYTES + 2) } : {},
      });
      if (!response.body) throw new Error('missing test body');
      reader = jest.spyOn(response.body, 'getReader');
      return response;
    });
    const result = await client('http://economic.test', 1000)
      .createObligation(INPUT)
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(String(result)).not.toContain('XXXX');
    expect(signal?.aborted).toBe(true);
    if (advertised) expect(reader).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('malformed JSON and malformed refusal envelopes expose no body fragments', async () => {
  const logs = jest.spyOn(Logger.prototype, 'error');
  for (const body of [
    'NOT_JSON_private-sentinel',
    '{"code":"toString","message":"private-sentinel"}',
  ]) {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 500 }));
    const result = await client('http://economic.test', 1000)
      .createObligation(INPUT)
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(String(result)).not.toContain('private-sentinel');
    expect(inspect(logs.mock.calls, { showHidden: true, depth: 8 })).not.toMatch(
      /private-sentinel|NOT_JSON/,
    );
    jest.restoreAllMocks();
  }
});

it('activity cancellation aborts fetch and stays a Temporal cancellation with the same financial key', async () => {
  let signal: AbortSignal | undefined;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let started: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    signal = init?.signal ?? undefined;
    started();
    return new Response(
      new ReadableStream({
        start(controller) {
          body = controller;
        },
      }),
      { status: 200 },
    );
  });
  const activity = new MockActivityEnvironment();
  const running = activity.run(() =>
    client('http://economic.test', 10_000).createObligation(INPUT),
  );
  await sent;
  activity.cancel();
  let timer: NodeJS.Timeout | undefined;
  try {
    await expect(
      Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('activity cancellation was not delivered')),
            1000,
          );
        }),
      ]),
    ).rejects.toBeInstanceOf(CancelledFailure);
    expect(signal?.aborted).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    body?.error(new Error('test stream cleanup'));
    await running.catch(() => undefined);
  }
  expect(fetch.mock.calls[0]?.[1]?.headers).toHaveProperty(
    'idempotency-key',
    'order:ORD_BOUND:hold',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('a parse that crosses the deadline is refused even before the abort timer gets CPU time', async () => {
  const parse = JSON.parse;
  jest.spyOn(JSON, 'parse').mockImplementation((text: string) => {
    if (text === '{"id":"late"}') {
      const until = performance.now() + 50;
      while (performance.now() < until) {
        /* bounded parse-cost simulation */
      }
    }
    return parse(text) as unknown;
  });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"late"}', { status: 200 }));
  await expect(client('http://economic.test', 10).createObligation(INPUT)).rejects.toMatchObject({
    code: 'UPSTREAM_UNAVAILABLE',
  });
});

it('cancellation listeners are removed when the transport exits', async () => {
  const env = new MockActivityEnvironment();
  let add: jest.SpyInstance | undefined;
  let remove: jest.SpyInstance | undefined;
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"id":"TXN_OK"}', { status: 200 }));
  await env.run(async () => {
    const signal = Context.current().cancellationSignal;
    add = jest.spyOn(signal, 'addEventListener');
    remove = jest.spyOn(signal, 'removeEventListener');
    await client('http://economic.test', 1000).createObligation(INPUT);
  });
  expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
  expect(remove).toHaveBeenCalledWith('abort', add?.mock.calls[0]?.[1]);
});

it('an always-ready chunk stream cannot starve the body deadline timer', async () => {
  let chunks = 0;
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks++;
          controller.enqueue(Uint8Array.of(32));
        },
      }),
      { status: 200 },
    ),
  );
  await expect(client('http://economic.test', 10).createObligation(INPUT)).rejects.toMatchObject({
    code: 'UPSTREAM_UNAVAILABLE',
  });
  expect(chunks).toBeLessThan(ECONOMIC_RESPONSE_MAX_BYTES);
});
