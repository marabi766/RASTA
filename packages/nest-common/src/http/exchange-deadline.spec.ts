import { ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '../errors/rasta-error';
import {
  ExchangeCancelledError,
  ExchangeDeadlineError,
  exchangeWithDeadline,
  upstreamExchange,
} from './exchange-deadline';

/** What a test can see of a body: whether the consumer gave it up. */
interface Watched {
  response: Response;
  readonly cancelled: () => boolean;
}

/** Headers now; a body that sends one chunk and never ends, ignoring any abort. */
function stalledBody(status = 200): Watched {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status },
  );
  return { response, cancelled: () => cancelled };
}

const sendOf =
  (response: Response | (() => Response | Promise<Response>)) => async (): Promise<Response> =>
    typeof response === 'function' ? response() : response;

describe('exchangeWithDeadline', () => {
  it('returns what the reader returns and leaves no timer behind', async () => {
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    try {
      await expect(
        exchangeWithDeadline(1_000, sendOf(new Response('ok')), (response) => response.text()),
      ).resolves.toBe('ok');
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });

  it("passes the exchange's own failure through, not a timeout", async () => {
    const failure = new TypeError('fetch failed');
    await expect(
      exchangeWithDeadline(
        1_000,
        async () => {
          throw failure;
        },
        () => 'unreachable',
      ),
    ).rejects.toBe(failure);
    const reading = new Error('bad body');
    await expect(
      exchangeWithDeadline(1_000, sendOf(new Response('x')), () => {
        throw reading;
      }),
    ).rejects.toBe(reading);
  });

  it('ends a body that stalls after the headers, aborts the signal and rejects with an AbortError', async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const watched = stalledBody();
    const outcome = exchangeWithDeadline(30, sendOf(watched.response), (response, signal) => {
      seen = signal;
      // The transport ignores the abort: only the deadline itself can end this.
      return response.text();
    });
    await expect(outcome).rejects.toBeInstanceOf(ExchangeDeadlineError);
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
        exchangeWithDeadline(40, sendOf(new Response(body, { status: 200 })), (response) =>
          response.text(),
        ),
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
        exchangeWithDeadline(
          10,
          (signal) =>
            new Promise<Response>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                setTimeout(() => reject(new Error('late')), 5),
              );
            }),
          () => 'unreachable',
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // PR #507 r1 F1: a refusal must not keep its connection after the deadline is released.
  describe('releasing a response (#507 r1 F1)', () => {
    it('cancels a body the reader never touched, at once, without waiting for the peer', async () => {
      const watched = stalledBody(503);
      let seen: AbortSignal | undefined;
      const started = Date.now();
      const status = await exchangeWithDeadline(
        5_000,
        (signal) => {
          seen = signal;
          return Promise.resolve(watched.response);
        },
        (response) => response.status,
      );
      expect(status).toBe(503);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(watched.cancelled()).toBe(true);
      expect(seen?.aborted).toBe(true);
    });

    it('aborts the signal when a reader throws before it has read the body', async () => {
      const watched = stalledBody();
      let seen: AbortSignal | undefined;
      await expect(
        exchangeWithDeadline(
          5_000,
          (signal) => {
            seen = signal;
            return Promise.resolve(watched.response);
          },
          () => {
            throw new Error('refused');
          },
        ),
      ).rejects.toThrow('refused');
      expect(watched.cancelled()).toBe(true);
      expect(seen?.aborted).toBe(true);
    });

    it('aborts when a reader stops reading early (a body over its cap)', async () => {
      const watched = stalledBody();
      let seen: AbortSignal | undefined;
      await exchangeWithDeadline(
        5_000,
        (signal) => {
          seen = signal;
          return Promise.resolve(watched.response);
        },
        async (response) => {
          const reader = response.body!.getReader();
          await reader.read();
          return 'stopped early';
        },
      );
      expect(seen?.aborted).toBe(true);
    });

    it('cancels the body of a response that arrives after the exchange has ended', async () => {
      const watched = stalledBody();
      let deliver: (response: Response) => void = () => undefined;
      await expect(
        exchangeWithDeadline(
          20,
          () =>
            new Promise<Response>((resolve) => {
              deliver = resolve;
            }),
          () => 'unreachable',
        ),
      ).rejects.toBeInstanceOf(ExchangeDeadlineError);
      deliver(watched.response);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(watched.cancelled()).toBe(true);
    });

    it('ends the signal with the exchange, so nothing of a finished call stays armed', async () => {
      let seen: AbortSignal | undefined;
      await expect(
        exchangeWithDeadline(
          1_000,
          (signal) => {
            seen = signal;
            return Promise.resolve(new Response('whole'));
          },
          (response) => response.text(),
        ),
      ).resolves.toBe('whole');
      expect(seen?.aborted).toBe(true);
    });
  });

  describe('a cancelling caller', () => {
    it('ends the exchange as cancelled, not as a timeout, and releases the response', async () => {
      const caller = new AbortController();
      const watched = stalledBody();
      let seen: AbortSignal | undefined;
      const outcome = exchangeWithDeadline(
        5_000,
        (signal) => {
          seen = signal;
          return Promise.resolve(watched.response);
        },
        (response) => response.text(),
        { cancel: caller.signal },
      );
      setTimeout(() => caller.abort(), 10);
      const error = await outcome.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExchangeCancelledError);
      expect(error).not.toBeInstanceOf(ExchangeDeadlineError);
      expect(seen?.aborted).toBe(true);
    });

    it('is cancelled at once when the caller has already left, and sends nothing', async () => {
      const caller = new AbortController();
      caller.abort();
      const send = jest.fn(sendOf(new Response('x')));
      await expect(
        exchangeWithDeadline(1_000, send, () => 'unreachable', { cancel: caller.signal }),
      ).rejects.toBeInstanceOf(ExchangeCancelledError);
      expect(send).not.toHaveBeenCalled();
    });

    it('names the cause that came first, and removes its listener on every exit', async () => {
      const caller = new AbortController();
      const remove = jest.spyOn(caller.signal, 'removeEventListener');
      await expect(
        exchangeWithDeadline(15, sendOf(stalledBody().response), (response) => response.text(), {
          cancel: caller.signal,
        }),
      ).rejects.toBeInstanceOf(ExchangeDeadlineError);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      caller.abort(); // after the fact: nothing left to affect
    });
  });
});

describe('upstreamExchange', () => {
  it('maps the deadline to UPSTREAM_TIMEOUT, naming the service and bound', async () => {
    const error = await upstreamExchange(
      'identity-service',
      20,
      sendOf(stalledBody().response),
      (response) => response.text(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe(ERROR_CODES.UPSTREAM_TIMEOUT);
    expect((error as RastaError).internalContext).toMatchObject({
      service: 'identity-service',
      timeoutMs: 20,
    });
  });

  it('passes a RastaError the reader raised through unchanged', async () => {
    const refusal = RastaError.upstreamUnavailable('identity-service');
    await expect(
      upstreamExchange('identity-service', 1_000, sendOf(new Response('x')), () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);
  });

  it('maps a transport failure or an unreadable body to UPSTREAM_UNAVAILABLE with no cause', async () => {
    const quoted = new TypeError('fetch failed: http://secret-host/path');
    const error = await upstreamExchange(
      'identity-service',
      1_000,
      async () => {
        throw quoted;
      },
      () => 'unreachable',
    ).catch((caught: unknown) => caught);
    expect((error as RastaError).code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
    expect((error as RastaError).cause).toBeUndefined();

    const parse = await upstreamExchange(
      'identity-service',
      1_000,
      sendOf(new Response('{')),
      (r) => r.json(),
    ).catch((caught: unknown) => caught);
    expect((parse as RastaError).code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
  });

  it('cancels the body of a status the reader refuses unread', async () => {
    const watched = stalledBody(500);
    await expect(
      upstreamExchange('identity-service', 5_000, sendOf(watched.response), (response) => {
        if (response.status !== 200) throw RastaError.upstreamUnavailable('identity-service');
        return response.text();
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.UPSTREAM_UNAVAILABLE });
    expect(watched.cancelled()).toBe(true);
  });
});
