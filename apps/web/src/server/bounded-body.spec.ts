/**
 * @jest-environment node
 */
import { BodyDeadlineError, BodyTooLargeError, readBoundedJson } from './bounded-body';

const streamed = (parts: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
  );

describe('readBoundedJson (PR #722 r1 F1/F2)', () => {
  it('parses up to exactly the ceiling and refuses one byte more', async () => {
    await expect(readBoundedJson(streamed(['{"a"', ':1}']), 7, Infinity)).resolves.toEqual({
      a: 1,
    });
    await expect(readBoundedJson(streamed(['{"a":', '10}']), 7, Infinity)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('stops an always-ready trickle at the deadline and cancels it', async () => {
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
    await expect(
      readBoundedJson(response, 1024 * 1024, performance.now() + 20),
    ).rejects.toBeInstanceOf(BodyDeadlineError);
    expect(cancelled).toBe(true);
  });
});

describe('readBoundedJson deadline after parsing (PR #722 r2 F2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects a body collected in time whose parsing crosses the deadline', async () => {
    let now = 900;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const parse = JSON.parse.bind(JSON);
    jest.spyOn(JSON, 'parse').mockImplementation(((text: string) => {
      now = 1_001;
      return parse(text) as unknown;
    }) as typeof JSON.parse);
    await expect(readBoundedJson(streamed(['{"a":1}']), 1024, 1_000)).rejects.toBeInstanceOf(
      BodyDeadlineError,
    );
  });

  it('decodes a BOM-prefixed body as `.json()` does', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    await expect(readBoundedJson(new Response(bom), 1024, Infinity)).resolves.toEqual({ a: 1 });
  });
});
