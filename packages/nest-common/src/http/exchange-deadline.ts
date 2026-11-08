import { RastaError } from '../errors/rasta-error';

/**
 * What {@link exchangeWithDeadline} rejects with when the deadline passes.
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
 * What {@link exchangeWithDeadline} rejects with when its `cancel` signal fires
 * first: the caller no longer wants the answer. Not a failure of the peer, and
 * not a timeout.
 */
export class ExchangeCancelledError extends Error {
  constructor() {
    super('The exchange was cancelled by its caller');
    this.name = 'AbortError';
  }
}

export interface ExchangeOptions {
  /**
   * The caller leaving. Ends the exchange like the deadline does — the request
   * is aborted and the response given up — but rejects with
   * {@link ExchangeCancelledError}, so the two causes stay apart.
   */
  readonly cancel?: AbortSignal;
}

/**
 * The one place an internal HTTP exchange gets its deadline (#502 r1 F1;
 * PR #507 r1 F1/F2): sending the request, reading the response **and** releasing it.
 *
 * `fetch` settles when the response headers arrive. A caller that clears its
 * own timer there has no deadline on the body, and one that returns on a
 * refusal status without reading the body leaves the connection and its
 * buffers to a peer that stalls or trickles — across every retry. Two
 * obligations follow, and this function owns both so a caller cannot forget
 * either:
 *
 * - The signal stays armed until `read` has settled, so `read` must consume
 *   the body it needs before it returns.
 * - A response's deadline is released only once its body is fully consumed or
 *   explicitly given up: a body `read` did not touch (a status-based refusal)
 *   is cancelled at once rather than awaited, and the signal is aborted on
 *   every exit, so a body read only in part or a request still in flight is
 *   cut too.
 *
 * The deadline is enforced here, not only requested of the transport: a body
 * that ignores the abort (a test double, a runtime that does not wire the
 * signal to the stream) still ends the exchange at the deadline. A response
 * that arrives after the exchange has ended is cancelled on arrival, and the
 * late outcome of an abandoned exchange has no reader and is discarded.
 *
 * The timer is cleared on every exit and does not keep the process alive.
 * Rejects with {@link ExchangeDeadlineError} when the deadline passed — also
 * when the transport's own abort error got there first — and otherwise with
 * the error `send` or `read` threw. When `options.cancel` fires first it
 * rejects with {@link ExchangeCancelledError} instead; whichever of the two
 * came first names the cause.
 */
export async function exchangeWithDeadline<T>(
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<Response>,
  read: (response: Response, signal: AbortSignal) => Promise<T> | T,
  options: ExchangeOptions = {},
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let endedBy: 'deadline' | 'caller' | undefined;
  let over = false;
  let response: Response | undefined;
  let onCancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const end = (by: 'deadline' | 'caller', error: Error) => {
      endedBy ??= by;
      controller.abort();
      reject(error);
    };
    timer = setTimeout(() => end('deadline', new ExchangeDeadlineError(timeoutMs)), timeoutMs);
    timer.unref?.();
    if (options.cancel) {
      onCancel = () => end('caller', new ExchangeCancelledError());
      if (options.cancel.aborted) onCancel();
      else options.cancel.addEventListener('abort', onCancel, { once: true });
    }
  });
  const running = (async () => {
    if (endedBy) throw endedError(endedBy, timeoutMs);
    const received = await send(controller.signal);
    response = received;
    if (over) {
      // The exchange ended while the request was in flight: nobody will read this.
      giveUp(received);
      throw endedError(endedBy, timeoutMs);
    }
    return read(received, controller.signal);
  })();
  // If the deadline wins, the exchange may still fail later (the abort reaches
  // the stream); nobody is left to read that.
  running.catch(() => undefined);
  try {
    const outcome = await Promise.race([running, stopped]);
    return outcome;
  } catch (error) {
    // The transport's own abort error can get here before the deadline's: the
    // cause is the one that ended the exchange first.
    throw endedBy ? endedError(endedBy, timeoutMs) : error;
  } finally {
    over = true;
    clearTimeout(timer);
    if (onCancel) options.cancel?.removeEventListener('abort', onCancel);
    if (response && !response.bodyUsed) giveUp(response);
    // The exchange is over, so nothing of it may outlive the call: an unread
    // body was cancelled above, and the abort covers what that cannot reach — a
    // body read only in part, a locked stream, a request still in flight. After
    // a body read to its end it has nothing left to cut.
    controller.abort();
  }
}

function endedError(by: 'deadline' | 'caller' | undefined, timeoutMs: number): Error {
  return by === 'caller' ? new ExchangeCancelledError() : new ExchangeDeadlineError(timeoutMs);
}

/** Cancels an unread body without waiting for the peer: a stalled one never answers. */
function giveUp(response: Response): void {
  try {
    Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // A locked or already-closed stream: the abort that follows ends it.
  }
}

/**
 * {@link exchangeWithDeadline} for a call to another service, with the platform's
 * error mapping: the deadline is `UPSTREAM_TIMEOUT`, a `RastaError` the reader
 * raised (a refusal it decided on) passes through, anything else — a transport
 * failure, a body that is not what was promised — is `UPSTREAM_UNAVAILABLE`.
 * No cause is attached: a runtime's transport error can quote the URL, and the
 * header beside it is the token.
 */
export async function upstreamExchange<T>(
  service: string,
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<Response>,
  read: (response: Response, signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  try {
    return await exchangeWithDeadline(timeoutMs, send, read);
  } catch (error) {
    if (error instanceof ExchangeDeadlineError) {
      throw RastaError.upstreamTimeout(service, timeoutMs);
    }
    if (error instanceof RastaError) throw error;
    throw RastaError.upstreamUnavailable(service);
  }
}
