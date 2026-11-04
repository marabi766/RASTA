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
