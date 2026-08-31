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

export interface ClamdClientOptions {
  readonly address: ClamdAddress;
  /**
   * The whole-exchange deadline, in milliseconds.
   *
   * One deadline for connect, write and reply together rather than three. A
   * per-phase timeout can be satisfied forever by a peer that sends one byte
   * before each expiry, which is precisely the shape of a scanner that is
   * struggling rather than dead.
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

export class ClamdClient {
  constructor(private readonly options: ClamdClientOptions) {}

  /** A short, safe description of where this client points. Carries no secret. */
  describeAddress(): string {
    return this.options.address.transport === 'unix'
      ? `unix:${this.options.address.socketPath}`
      : `tcp:${this.options.address.host}:${this.options.address.port}`;
  }

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
   */
  async scanStream(source: Readable, signal?: AbortSignal): Promise<ClamdReply> {
    return this.withSocket(async (socket, reply) => {
      socket.write(INSTREAM_COMMAND);

      let sent = 0;

      try {
        for await (const piece of source) {
          if (signal?.aborted) {
            throw new ClamdError('TIMEOUT', 'the scan was cancelled by its caller');
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
              await once(socket, 'drain');
            }
          }
        }
      } finally {
        // Always, including on the size refusal above. Leaving a half-written
        // stream open holds a clamd thread until its own ReadTimeout fires.
        source.destroy();
      }

      socket.write(INSTREAM_TERMINATOR);
      return parseInstreamReply(await reply);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A command with no body. */
  private async exchange(command: string): Promise<string> {
    return this.withSocket(async (socket, reply) => {
      socket.write(command);
      return reply;
    });
  }

  /**
   * Opens a connection, runs `speak`, and closes it under one deadline.
   *
   * The reply promise is created **before** `speak` runs, so a scanner that
   * answers before the last frame is written — which clamd does when it
   * matches early — is not a race that loses the reply.
   */
  private async withSocket<T>(
    speak: (socket: net.Socket, reply: Promise<string>) => Promise<T>,
  ): Promise<T> {
    const socket = this.connect();
    const chunks: Buffer[] = [];

    let settle!: (value: string) => void;
    let reject!: (error: Error) => void;
    const reply = new Promise<string>((resolve, rejectReply) => {
      settle = resolve;
      reject = rejectReply;
    });
    // Nothing awaits `reply` on the failure paths below, and an unhandled
    // rejection would take the process down rather than the scan.
    reply.catch(() => undefined);

    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new ClamdError('TIMEOUT', 'the scanner did not answer within the deadline'));
    }, this.options.timeoutMs);
    deadline.unref?.();

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      // clamd answers one NUL-terminated message per exchange and then waits;
      // it does not close first. Resolving on the terminator rather than on
      // `end` is the difference between a reply and a timeout.
      const seen = Buffer.concat(chunks).toString('latin1');
      if (seen.includes('\0')) settle(seen);
    });

    socket.on('error', (error) => {
      reject(
        error instanceof ClamdError
          ? error
          : new ClamdError('CONNECTION_FAILED', safeSocketError(error)),
      );
    });

    socket.on('close', () => {
      // A close with nothing received is a refusal or a reset. A close after a
      // complete reply has already settled the promise and this is a no-op.
      reject(
        new ClamdError('PROTOCOL_ERROR', 'the scanner closed the connection without answering'),
      );
    });

    try {
      await once(socket, 'connect');
      return await speak(socket, reply);
    } finally {
      clearTimeout(deadline);
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
 * Awaits one event, rejecting if the socket fails first.
 *
 * `events.once` would hang on `connect` for a socket that emitted `error`,
 * because the error listener registered above does not settle this promise.
 */
function once(socket: net.Socket, event: 'connect' | 'drain'): Promise<void> {
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
    const cleanup = (): void => {
      socket.off(event, onEvent);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    socket.once(event, onEvent);
    socket.once('error', onError);
    socket.once('close', onClose);
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
