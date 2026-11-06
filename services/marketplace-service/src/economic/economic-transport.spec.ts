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

const streamed = (parts: Uint8Array[], status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { status },
  );

/** Records every size `Buffer` is asked to allocate while the test runs. */
const recordAllocations = () => {
  const sizes: number[] = [];
  for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow'] as const) {
    const original = Buffer[name].bind(Buffer);
    jest.spyOn(Buffer, name).mockImplementation(((size: number, ...rest: never[]) => {
      sizes.push(size);
      return (original as (...args: unknown[]) => Buffer)(size, ...rest);
    }) as never);
  }
  return sizes;
};

it('a small body allocates in proportion to what arrived, never the ceiling (FU-044)', async () => {
  const sizes = recordAllocations();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamed([Buffer.from('{}')]));
  await expect(client('http://economic.test', 1000).createObligation(INPUT)).resolves.toEqual({});
  expect(Math.max(0, ...sizes)).toBeLessThan(1024);
});

it('a chunked body of exactly the ceiling is accepted; one byte more is refused', async () => {
  const body = `"${'X'.repeat(ECONOMIC_RESPONSE_MAX_BYTES - 2)}"`;
  const half = ECONOMIC_RESPONSE_MAX_BYTES / 2;
  const parts = (text: string) => [Buffer.from(text.slice(0, half)), Buffer.from(text.slice(half))];
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamed(parts(body)));
  await expect(client('http://economic.test', 1000).createObligation(INPUT)).resolves.toHaveLength(
    ECONOMIC_RESPONSE_MAX_BYTES - 2,
  );
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamed(parts(`${body} `)));
  await expect(client('http://economic.test', 1000).createObligation(INPUT)).rejects.toMatchObject({
    code: 'UPSTREAM_UNAVAILABLE',
  });
});

it('a multi-byte character split across chunks decodes; invalid UTF-8 and an empty 200 are refused', async () => {
  const text = Buffer.from('{"id":"ت"}');
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(streamed([text.subarray(0, 8), text.subarray(8)]));
  await expect(client('http://economic.test', 1000).createObligation(INPUT)).resolves.toEqual({
    id: 'ت',
  });
  for (const parts of [[Uint8Array.of(0x22, 0xff, 0x22)], []]) {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamed(parts));
    await expect(
      client('http://economic.test', 1000).createObligation(INPUT),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  }
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await expect(
    client('http://economic.test', 1000).createObligation(INPUT),
  ).resolves.toBeUndefined();
});

it('a body in many tiny chunks keeps no chunk and allocates in proportion to its bytes (FU-044 r2)', async () => {
  // 64 KiB of JSON delivered one byte per read. The producer scribbles over
  // each chunk once the next read is pulled, as a transport reusing its
  // buffers would: a reader that kept the chunks it was handed decodes the
  // scribble, a reader that copied them decodes the body. `highWaterMark: 0`
  // means a pull only happens while a read is waiting, i.e. after the reader
  // is done with the previous chunk.
  const body = Buffer.from(`"${'Y'.repeat(64 * 1024 - 2)}"`);
  let previous: Uint8Array | undefined;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        previous?.fill(0xff);
        if (offset === body.byteLength) return controller.close();
        previous = Uint8Array.of(body[offset++]!);
        controller.enqueue(previous);
      },
    },
    { highWaterMark: 0 },
  );
  const sizes = recordAllocations();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));
  await expect(
    client('http://economic.test', 10_000).createObligation(INPUT),
  ).resolves.toHaveLength(body.byteLength - 2);
  // Geometric growth from 256 bytes: at most ~log2(64 KiB / 256) + 1 buffers,
  // together under twice the final one, whatever the number of chunks.
  expect(sizes.length).toBeLessThanOrEqual(10);
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * 2 * body.byteLength);
});

it('growth never allocates past the ceiling, even when doubling would overshoot it', async () => {
  // 3000-byte chunks: doubling from 3000 passes 1 MiB (3000 · 2⁹ > 2²⁰), so
  // only the clamp keeps the last buffer at the ceiling.
  const body = Buffer.from(`"${'Z'.repeat(ECONOMIC_RESPONSE_MAX_BYTES - 2)}"`);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < body.byteLength; at += 3000) parts.push(body.subarray(at, at + 3000));
  const sizes = recordAllocations();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamed(parts));
  await expect(
    client('http://economic.test', 10_000).createObligation(INPUT),
  ).resolves.toHaveLength(ECONOMIC_RESPONSE_MAX_BYTES - 2);
  expect(Math.max(...sizes)).toBe(ECONOMIC_RESPONSE_MAX_BYTES);
});
