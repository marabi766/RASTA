import { withExchangeDeadline } from './exchange-deadline';

/** Headers now; a body that sends one chunk and never ends, ignoring any abort. */
function stalledBody(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
      },
    }),
    { status: 200 },
  );
}

describe('withExchangeDeadline', () => {
  it('returns what the exchange returns and leaves no timer behind', async () => {
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(withExchangeDeadline(1_000, async () => 'done')).resolves.toBe('done');
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });

  it("passes the exchange's own failure through, not a timeout", async () => {
    const failure = new TypeError('fetch failed');
    await expect(
      withExchangeDeadline(1_000, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('ends a body that stalls after the headers, aborts the signal and rejects with an AbortError', async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const outcome = withExchangeDeadline(30, async (signal) => {
      seen = signal;
      // The transport ignores the abort: only the deadline itself can end this.
      return stalledBody().text();
    });
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen?.aborted).toBe(true);
  });

  it('ends a body that trickles forever', async () => {
    let trickle: NodeJS.Timeout | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        trickle = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 5);
      },
      cancel() {
        clearInterval(trickle);
      },
    });
    try {
      await expect(
        withExchangeDeadline(40, () => new Response(body, { status: 200 }).text()),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      clearInterval(trickle);
    }
  });

  it('does not let the abandoned exchange surface as an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);
    try {
      await expect(
        withExchangeDeadline(10, (signal) => {
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => setTimeout(() => reject(new Error('late')), 5));
          });
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('is not extended by the exchange finishing early', async () => {
    // The timer is cleared on success: a later expiry must not abort a finished exchange.
    let seen: AbortSignal | undefined;
    await withExchangeDeadline(20, async (signal) => {
      seen = signal;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen?.aborted).toBe(false);
  });
});
