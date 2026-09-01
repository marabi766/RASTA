import net from 'node:net';
import type { Readable } from 'node:stream';
import {
  INSTREAM_COMMAND,
  INSTREAM_TERMINATOR,
  PING_COMMAND,
  VERSION_COMMAND,
  frameChunk,
  isPong,
  parseInstreamReply,
  parseVersionReply,
  type ClamdReply,
  type ClamdVersion,
} from './protocol';

/**
 * The socket half of the clamd adapter.
 *
 * Everything with a timer, a file descriptor or a network address is here, and
 * everything that decides what a reply *means* is in `protocol.ts`. The split
 * is what makes the interesting failures — a half-arrived reply, a signature
 * named `OK-Something`, an engine error — testable without a scanner.
 *
 * ## One connection per exchange
 *
 * clamd's `INSTREAM` occupies a connection for the whole stream and the
 * connection is not reusable afterwards, so pooling would buy nothing and cost
 * the correctness of "a hung scan holds one socket and releases it on its own
 * deadline". Each call connects, speaks, and closes.
 *
 * ## Who owns cancellation
 *
 * One `AbortController` per exchange, created here and passed down. It is the
 * single thing that ends an exchange, whoever noticed first: the deadline
 * timer, the caller's own signal, a socket error, a peer that hung up, or a
 * reply that grew past what a reply may be. Everything that can block —
 * connecting, iterating the source, waiting for backpressure, waiting for the
 * answer — is tied to it.
 *
 * That centralisation is a correction, not a preference. The timer used to
 * destroy the clamd socket and reject the reply promise, and neither of those
 * unblocks a `for await` parked on an object stream that has stopped
 * producing: the stream was destroyed in the loop's `finally`, which cannot
 * run until the loop resumes. A stalled MinIO connection therefore outlived
 * `DOCUMENT_SCAN_TIMEOUT_MS` indefinitely — holding a worker slot, delaying
 * shutdown and letting the document's lease drift towards expiry — while the
 * configuration and this comment both claimed a deadline. The deadline is now
 * one, and `clamav.scanner.spec.ts` proves it by stalling a source on purpose.
 *
 * ## Where the transport is decided, and where it is refused
 *
 * This class connects to whatever address it is given. It does **not** decide
 * whether that address is acceptable — `documentEnvSchema` does, at startup,
 * and refuses a TCP scanner outright in production (ADR-049, AGENTS.md S-08).
 * Putting the policy in configuration rather than here means a deployment
 * fails to start rather than failing on the first document.
 */

export type ClamdAddress =
  | { readonly transport: 'unix'; readonly socketPath: string }
  | { readonly transport: 'tcp'; readonly host: string; readonly port: number };

/**
 * The most a single clamd reply may weigh before it is refused.
 *
 * A healthy clamd answers in well under a hundred bytes: `stream: OK`, a
 * signature name bounded by the database's own naming, a version line. Even
 * `zSTATS`, which this client does not use, is a few hundred. Eight kilobytes
 * is therefore enormous for a legitimate reply and small enough to be a real
 * bound.
 *
 * It exists because without one, a peer that is broken or hostile decides how
 * much memory this process holds — and the accumulator concatenated everything
 * received on every packet, so the cost of being fed grew quadratically with
 * what was sent.
 *
 * Measured against the cumulative size **through the first terminator**, which
 * is the only measurement a peer cannot step around: bounding only
 * unterminated data leaves an oversized reply acceptable as long as it ends
 * with a NUL, which is exactly what the first version of this check allowed.
 *
 * The refusal reports the limit and never the content: this string reaches
 * logs and metrics, and echoing an unbounded reply from an untrusted peer into
 * either is the second bug rather than the fix (S-09).
 */
export const MAX_REPLY_BYTES = 8 * 1024;

export interface ClamdClientOptions {
  readonly address: ClamdAddress;
  /**
   * The whole-exchange deadline, in milliseconds.
   *
   * One deadline for connect, streaming, backpressure and reply together
   * rather than four. A per-phase timeout can be satisfied forever by a peer
   * that sends one byte before each expiry, which is precisely the shape of a
   * scanner that is struggling rather than dead — and a deadline that covers
   * only the reply is satisfied forever by a *source* that has gone quiet,
   * which is the defect this now closes.
   */
  readonly timeoutMs: number;
  /** Bytes per INSTREAM frame. Bounds how much of the object is ever resident. */
  readonly chunkBytes: number;
  /**
   * The most this client will stream in one exchange.
   *
   * Enforced while streaming, not only before it: `sizeBytes` comes from
   * storage metadata, and a ceiling checked once against a number is not a
   * ceiling on what actually goes over the socket.
   */
  readonly maxBytes: number;
}

/** A failure that names its kind, so the adapter can map it without string matching. */
export class ClamdError extends Error {
  constructor(
    readonly kind: 'TIMEOUT' | 'CONNECTION_FAILED' | 'PROTOCOL_ERROR' | 'SIZE_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'ClamdError';
  }
}

/** What `speak` is given: the socket, the pending reply, and the exchange's life. */
interface Exchange {
  readonly socket: net.Socket;
  readonly reply: Promise<string>;
  /**
   * Aborted when the exchange ends for any reason but success.
   *
   * `signal.reason` is the {@link ClamdError} that ended it, so a consumer can
   * propagate the *kind* rather than flattening every ending into a timeout.
   */
  readonly signal: AbortSignal;
}

export class ClamdClient {
  constructor(private readonly options: ClamdClientOptions) {}

  async ping(): Promise<boolean> {
    const reply = await this.exchange(PING_COMMAND);
    return isPong(reply);
  }

  async version(): Promise<ClamdVersion> {
    const reply = await this.exchange(VERSION_COMMAND);
    const parsed = parseVersionReply(reply);
    if (!parsed) {
      throw new ClamdError('PROTOCOL_ERROR', 'the scanner did not report a usable version');
    }
    return parsed;
  }

  /**
   * Streams `source` to clamd and returns its verdict.
   *
   * The stream is consumed in frames of `chunkBytes` and never accumulated, so
   * the resident cost of scanning a 25 MB document is one frame — the ADR-014
   * promise that the file does not pass through the service, kept as far as an
   * out-of-band scan allows (ADR-049 § "What this amends").
   *
   * Backpressure is honoured rather than assumed: a socket that reports a full
   * buffer is waited on before the next frame is written. Without that a fast
   * object read and a slow scanner turn into an unbounded write queue inside
   * the process — the same memory this method exists to avoid, moved from the
   * stream to the socket.
   *
   * ## The source belongs to the exchange
   *
   * Destroying it is how a deadline reaches a loop that is parked waiting for
   * bytes. Checking a flag between chunks cannot: there is no "between" while
   * the next chunk never arrives. So the source is destroyed *with the
   * exchange's own error*, which makes the iterator reject with that error and
   * the failure keep its kind instead of becoming a generic one.
   */
  async scanStream(source: Readable, signal?: AbortSignal): Promise<ClamdReply> {
    return this.withSocket(async ({ socket, reply, signal: exchange }) => {
      // Registered before the first read, so a deadline that expires during
      // the very first chunk still reaches the stream.
      const abandonSource = (): void => {
        source.destroy(errorOf(exchange, 'the scan ended before the object was fully read'));
      };
      exchange.addEventListener('abort', abandonSource, { once: true });

      socket.write(INSTREAM_COMMAND);

      let sent = 0;

      try {
        for await (const piece of source) {
          // A cheap fast path only. The interruption that matters is
          // `abandonSource` above — this check cannot run while the loop is
          // waiting, which is exactly when it would be needed.
          if (exchange.aborted) {
            throw errorOf(exchange, 'the scan was cancelled');
          }

          const bytes = piece as Buffer;
          for (let offset = 0; offset < bytes.length; offset += this.options.chunkBytes) {
            const frame = bytes.subarray(offset, offset + this.options.chunkBytes);
            sent += frame.length;

            if (sent > this.options.maxBytes) {
              // Refused here rather than left to clamd's StreamMaxLength: the
              // deployment's ceiling is this service's decision, and reaching
              // the engine's limit instead would report the failure as an
              // engine error rather than as a policy one.
              throw new ClamdError(
                'SIZE_LIMIT_EXCEEDED',
                'the object exceeded the configured scan size limit',
              );
            }

            if (!socket.write(frameChunk(frame))) {
              await once(socket, 'drain', exchange);
            }
          }
        }
      } finally {
        exchange.removeEventListener('abort', abandonSource);
        // Always, including on the size refusal above and on a deadline that
        // already destroyed it. Leaving a half-written stream open holds a
        // clamd thread until its own ReadTimeout fires, and leaves the S3
        // connection behind it open until the SDK's.
        source.destroy();
      }

      socket.write(INSTREAM_TERMINATOR);
      return parseInstreamReply(await reply);
    }, signal);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A command with no body. */
  private async exchange(command: string): Promise<string> {
    return this.withSocket(async ({ socket, reply }) => {
      socket.write(command);
      return reply;
    });
  }

  /**
   * Opens a connection, runs `speak`, and ends the whole thing under one
   * deadline.
   *
   * The reply promise is created **before** `speak` runs, so a scanner that
   * answers before the last frame is written — which clamd does when it
   * matches early — is not a race that loses the reply.
   *
   * Every await inside is raced against the exchange's cancellation, so this
   * method returns when the deadline says so even if `speak` is still
   * unwinding. `speak` is cancelled as well as raced: the race decides when
   * *this* returns, and the abort decides that nothing keeps reading after it.
   */
  private async withSocket<T>(
    speak: (exchange: Exchange) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const socket = this.connect();
    const cancellation = new AbortController();

    /**
     * The one reason this exchange ended, recorded once.
     *
     * Latched, so the first cause wins: destroying the socket on a timeout
     * makes it emit `close`, and without the latch that second event would
     * relabel a deadline as a protocol failure.
     */
    let failure: ClamdError | null = null;

    let settleReply!: (value: string) => void;
    let rejectReply!: (error: Error) => void;
    const reply = new Promise<string>((resolve, reject) => {
      settleReply = resolve;
      rejectReply = reject;
    });
    // Nothing awaits `reply` on the failure paths below, and an unhandled
    // rejection would take the process down rather than the scan.
    reply.catch(() => undefined);

    const fail = (error: ClamdError): void => {
      if (failure) return;
      failure = error;
      cancellation.abort(error);
      rejectReply(error);
      // Released here rather than only in the `finally`, so a peer holding a
      // scanning thread for us is let go the moment we stop waiting.
      socket.destroy();
    };

    // Rejects when the exchange is cancelled, so an await that cannot be
    // interrupted any other way still ends.
    let onCancelled!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onCancelled = () => reject(errorOf(cancellation.signal, 'the exchange was cancelled'));
      cancellation.signal.addEventListener('abort', onCancelled, { once: true });
    });
    cancelled.catch(() => undefined);

    const deadline = setTimeout(
      () => fail(new ClamdError('TIMEOUT', 'the exchange did not complete within the deadline')),
      this.options.timeoutMs,
    );
    deadline.unref?.();

    const onCallerAbort = (): void =>
      fail(new ClamdError('TIMEOUT', 'the scan was cancelled by its caller'));
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    // ---- Reply accumulation, bounded ------------------------------------
    //
    // `received` counts only bytes that belong to the reply — everything up to
    // and including the first terminator. The bound is measured against that
    // count rather than against whatever arrived, because the question it
    // answers is "how large is this reply", not "how much did the peer send".
    let received = 0;
    let answered = false;
    const chunks: Buffer[] = [];

    /** Drops what has been buffered and ends the exchange. Never quotes it. */
    const refuseReply = (why: string): void => {
      chunks.length = 0;
      fail(new ClamdError('PROTOCOL_ERROR', why));
    };

    const onData = (chunk: Buffer): void => {
      // Once a reply is complete this exchange is over; anything further is
      // not part of it and must not disturb it.
      if (answered || failure) return;

      // A terminator is one byte, so it cannot straddle two arrivals: finding
      // it per chunk is complete, and avoids re-joining everything per packet.
      const terminator = chunk.indexOf(0);
      const belongsToReply = terminator === -1 ? chunk.length : terminator + 1;

      // Checked **before** the reply is accepted, not after.
      //
      // This test used to sit behind an early return on the terminator, so a
      // peer that ended an oversized reply with a NUL had it accepted and
      // concatenated in full: the bound was documented and not enforced. The
      // limit now applies to the cumulative size through the first terminator,
      // which is the only measurement that cannot be stepped around by
      // terminating late.
      if (received + belongsToReply > MAX_REPLY_BYTES) {
        refuseReply(`the scanner sent more than ${MAX_REPLY_BYTES} bytes for one reply`);
        return;
      }

      if (terminator === -1) {
        received += chunk.length;
        chunks.push(chunk);
        return;
      }

      // Bytes after the terminator are a second message on an exchange that
      // carries exactly one. Refused rather than truncated to the first: a
      // peer able to append after a valid reply would otherwise choose what
      // this client reads and what it silently discards.
      if (belongsToReply < chunk.length) {
        refuseReply('the scanner sent more than one message on one exchange');
        return;
      }

      received += belongsToReply;
      chunks.push(chunk);
      answered = true;
      settleReply(Buffer.concat(chunks).toString('latin1'));
      // Handed over as a string; retaining the buffers past that point keeps
      // the reply resident for the life of the exchange for no reason.
      chunks.length = 0;
    };

    const onError = (error: Error): void => {
      // A complete reply is already in hand, so a socket error while the peer
      // tears the connection down is how some exchanges end rather than a scan
      // failure. See `onClose` for why `fail` alone does not cover this.
      if (answered) return;
      fail(
        error instanceof ClamdError
          ? error
          : new ClamdError('CONNECTION_FAILED', safeSocketError(error)),
      );
    };

    const onClose = (): void => {
      // A close *after* a complete reply is how a well-behaved clamd ends an
      // exchange, and must not be reported as one failing.
      //
      // The comment here used to say that was already a no-op. It was not:
      // `fail` is latched against a second *failure*, not against a success,
      // so nothing but scheduling stopped a close from aborting an exchange
      // that had already answered. Today the reply's continuation is a
      // microtask and the close is a macrotask, so the verdict always wins
      // that race — which is why removing this guard does not currently fail a
      // test. That is an accident of ordering rather than an invariant: any
      // future `speak` that awaits something after the reply, or a transport
      // that delivers both in one turn, loses a valid verdict — and for an
      // `INFECTED` reply that means a real finding recorded as an unexplained
      // protocol error.
      //
      // The guard makes the rule explicit instead of implied.
      if (answered) return;
      // A close with nothing complete received is a refusal or a reset.
      fail(new ClamdError('PROTOCOL_ERROR', 'the scanner closed the connection without answering'));
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);

    try {
      await Promise.race([once(socket, 'connect', cancellation.signal), cancelled]);

      const work = speak({ socket, reply, signal: cancellation.signal });
      // The race may settle from `cancelled` first, leaving this rejection
      // with nobody to receive it.
      work.catch(() => undefined);

      return await Promise.race([work, cancelled]);
    } finally {
      clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', onCallerAbort);
      cancellation.signal.removeEventListener('abort', onCancelled);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      // A destroyed socket can still emit, and an `error` with no listener is
      // an uncaught exception rather than a scan failure.
      socket.on('error', () => undefined);
      socket.destroy();
    }
  }

  private connect(): net.Socket {
    const { address } = this.options;
    const socket =
      address.transport === 'unix'
        ? net.connect({ path: address.socketPath })
        : net.connect({ host: address.host, port: address.port });

    // Nagle would hold a small frame waiting for company, which for a stream of
    // framed chunks is latency added to every document for no gain.
    socket.setNoDelay(true);
    return socket;
  }
}

/**
 * The error an abort carried, or a timeout if it carried none.
 *
 * Keeps a size refusal a size refusal and a refused connection a refused
 * connection, instead of flattening every ending into the one that happened to
 * stop the waiting.
 */
function errorOf(signal: AbortSignal, fallback: string): ClamdError {
  return signal.reason instanceof ClamdError ? signal.reason : new ClamdError('TIMEOUT', fallback);
}

/**
 * Awaits one event, rejecting if the socket fails or the exchange ends first.
 *
 * `events.once` would hang on `connect` for a socket that emitted `error`,
 * because the error listener registered by the caller does not settle this
 * promise — and it would hang on `drain` forever against a peer that stopped
 * reading, which is the backpressure half of the same deadline problem.
 */
function once(socket: net.Socket, event: 'connect' | 'drain', signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(
        error instanceof ClamdError
          ? error
          : new ClamdError('CONNECTION_FAILED', safeSocketError(error)),
      );
    };
    const onClose = (): void => {
      cleanup();
      reject(new ClamdError('CONNECTION_FAILED', 'the connection closed before it was ready'));
    };
    const onAbort = (): void => {
      cleanup();
      reject(errorOf(signal as AbortSignal, 'the exchange ended while waiting on the socket'));
    };
    const cleanup = (): void => {
      socket.off(event, onEvent);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    socket.once(event, onEvent);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A socket failure reduced to its code.
 *
 * `error.message` on a connection failure carries the address — a socket path
 * or a host and port — and this string reaches logs and the readiness probe.
 * The code (`ECONNREFUSED`, `ENOENT`, `EACCES`) is what an operator needs and
 * names nothing (AGENTS.md S-09).
 */
function safeSocketError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'connection failed';
}
