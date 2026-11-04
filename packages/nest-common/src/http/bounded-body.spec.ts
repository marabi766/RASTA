import { ExchangeDeadlineError } from './exchange-deadline';
import {
  BodyTooLargeError,
  BoundedBodyCollector,
  readBoundedJson,
  readBoundedText,
  readCappedText,
} from './bounded-body';

const streamed = (parts: Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
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

afterEach(() => jest.restoreAllMocks());

describe('BoundedBodyCollector', () => {
  it('accepts exactly the cap and refuses, copying nothing, the chunk that would pass it', () => {
    const body = new BoundedBodyCollector(10);
    expect(body.append(Buffer.from('01234'))).toBe(true);
    expect(body.append(Buffer.from('56789'))).toBe(true);
    expect(body.append(Buffer.from('X'))).toBe(false);
    expect(body.toBuffer().toString()).toBe('0123456789');
    body.clear();
    expect(body.byteLength).toBe(0);
    expect(body.toBuffer().byteLength).toBe(0);
  });

  it('keeps no chunk it was handed and allocates in proportion to its bytes (FU-044 r2)', async () => {
    // 64 KiB delivered one byte per read. The producer scribbles over each
    // chunk once the next read is pulled, as a transport reusing its buffers
    // would: a reader that kept the chunks it was handed decodes the scribble,
    // a reader that copied them decodes the body. `highWaterMark: 0` means a
    // pull only happens while a read is waiting, i.e. after the previous chunk
    // was handed over.
    const body = Buffer.from('Y'.repeat(64 * 1024));
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
    await expect(readCappedText(new Response(stream), 1024 * 1024)).resolves.toBe(body.toString());
    // Geometric growth from 256 bytes: at most ~log2(64 KiB / 256) + 1 buffers,
    // together under twice the final one, whatever the number of chunks.
    expect(sizes.length).toBeLessThanOrEqual(10);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * 2 * body.byteLength);
  });

  it('never allocates past the cap, even when doubling would overshoot it', () => {
    // 3000-byte chunks: doubling from 3000 passes 1 MiB (3000 · 2⁹ > 2²⁰), so
    // only the clamp keeps the last buffer at the cap.
    const cap = 1024 * 1024;
    const sizes = recordAllocations();
    const body = new BoundedBodyCollector(cap);
    const chunk = Buffer.from('Z'.repeat(3000));
    while (body.byteLength + chunk.byteLength <= cap) expect(body.append(chunk)).toBe(true);
    expect(body.append(Buffer.from('Z'.repeat(cap - body.byteLength)))).toBe(true);
    expect(body.byteLength).toBe(cap);
    expect(Math.max(...sizes)).toBe(cap);
  });
});

describe('readCappedText', () => {
  it('reads a body within the limit, and a missing body as empty text', async () => {
    await expect(readCappedText(new Response('hello'), 10)).resolves.toBe('hello');
    await expect(readCappedText(new Response(null), 10)).resolves.toBe('');
    await expect(readCappedText(streamed([]), 10)).resolves.toBe('');
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const text = Buffer.from('{"id":"ت"}');
    await expect(
      readCappedText(streamed([text.subarray(0, 8), text.subarray(8)]), 64),
    ).resolves.toBe('{"id":"ت"}');
  });

  it('a chunked body of exactly the limit is read; one byte more stops reading and cancels', async () => {
    await expect(
      readCappedText(streamed([Buffer.from('01234'), Buffer.from('56789')]), 10),
    ).resolves.toBe('0123456789');
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(Buffer.from('0123456'));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(readCappedText(new Response(stream), 10)).resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  it('a declared length past the limit is refused unread', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { headers: { 'content-length': '11' } });
    await expect(readCappedText(response, 10)).resolves.toBeNull();
    expect(pulled).toBe(false);
  });
});

describe('readBoundedText / readBoundedJson (PR #722 r1 F1/F2)', () => {
  it('are `.text()` / `.json()` with a ceiling: exact cap read, one byte more refused', async () => {
    await expect(readBoundedText(streamed([Buffer.from('ab'), Buffer.from('c')]), 3)).resolves.toBe(
      'abc',
    );
    await expect(readBoundedText(streamed([Buffer.from('abcd')]), 3)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    await expect(readBoundedJson(streamed([Buffer.from('{"a":1}')]), 7)).resolves.toEqual({ a: 1 });
    await expect(readBoundedJson(streamed([Buffer.from('{"a":')]), 7)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it('stops at a caller-given monotonic deadline between chunks and cancels the stream', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Uint8Array.of(0x20));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const read = readBoundedText(response, 1024 * 1024, { deadlineAt: performance.now() + 20 });
    await expect(read).rejects.toBeInstanceOf(ExchangeDeadlineError);
    expect(cancelled).toBe(true);
  });
});
