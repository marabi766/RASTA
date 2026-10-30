/**
 * What {@link withExchangeDeadline} rejects with when the deadline passes.
 * Named `AbortError`, like what an aborted `fetch` rejects with, so a caller's
 * existing timeout handling for a header-time abort covers the body too; an
 * `Error` of the caller's own realm whatever the runtime made of the abort, so
 * `instanceof Error` holds. Carries no URL, header or body.
 */
export class ExchangeDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`The exchange did not complete within ${timeoutMs} ms`);
    this.name = 'AbortError';
  }
}

/**
 * One deadline over a whole HTTP exchange: sending the request **and**
 * consuming the response body (PR #502 r1 F1).
 *
 * `fetch` settles when the response headers arrive. A server that answers
 * `200` and then stalls, or trickles an incomplete body, would otherwise hold
 * a caller that already cleared its timer for as long as the socket lives. The
 * signal passed to `exchange` therefore stays armed until `exchange` itself
 * settles, so `exchange` must read the body before it returns.
 *
 * The deadline is also enforced here, not only requested of the transport: a
 * body that ignores the abort (a test double, a runtime that does not wire the
 * signal to the stream) still ends the exchange at the deadline. The late
 * outcome of an abandoned exchange has no reader and is discarded.
 *
 * The timer is cleared on every exit and does not keep the process alive.
 * Rejects with {@link ExchangeDeadlineError} when the deadline passes, and with
 * the exchange's own error when it fails first.
 */
export async function withExchangeDeadline<T>(
  timeoutMs: number,
  exchange: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExchangeDeadlineError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  const running = (async () => exchange(controller.signal))();
  // If the deadline wins, the exchange may still fail later (the abort reaches
  // the stream); nobody is left to read that.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}
