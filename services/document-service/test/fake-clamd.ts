import net from 'node:net';
import { AddressInfo } from 'node:net';

/**
 * A clamd that speaks the wire protocol and answers whatever a test tells it
 * to.
 *
 * A real TCP server rather than a mocked socket, because what these tests are
 * checking is transport behaviour: a connection refused, a peer that accepts
 * and never answers, a reply that arrives in two packets, a server that closes
 * mid-stream. None of those exist if the socket is a stub, and every one of
 * them is a way a scanner returns the wrong answer.
 *
 * ## Why it lives in `test/`
 *
 * It started in `src/`, next to the spec that uses it, and that was wrong for
 * a reason worth recording: `tsconfig.json` includes `src/**` and excludes
 * only `*.spec.ts` and `test/**`, so a TCP server that answers whatever a test
 * tells it to would have been compiled into `dist` and shipped inside the
 * production image. It also counted towards the coverage figure, which a test
 * double has no business influencing in either direction.
 *
 * Here it cannot reach a deployment even by accident, which is the same rule
 * `clean-scanner.ts` follows and for the same reason.
 */

export type FakeBehaviour =
  /** Answer this exact string (including any terminator) and stay open. */
  | { kind: 'reply'; text: string }
  /** Answer in two packets, to prove the reply is reassembled. */
  | { kind: 'split'; first: string; second: string; delayMs: number }
  /** Accept the connection and never say anything. */
  | { kind: 'silent' }
  /** Accept and close without answering. */
  | { kind: 'close' }
  /**
   * Send `bytes` of filler with **no** terminator, and keep sending.
   *
   * The reply accumulator's bound is not otherwise reachable: a healthy clamd
   * answers in under a hundred bytes and always terminates, so a client that
   * buffered without limit would look correct until something on the other end
   * was broken or hostile.
   */
  | { kind: 'flood'; bytes: number }
  /**
   * Write `text` and close in the same breath.
   *
   * How a clamd that is shutting down, or being cycled by an orchestrator,
   * ends an exchange it has already answered. `socket.end(payload)` sends the
   * bytes and the FIN together, so the client is very likely to see `data` and
   * `close` inside one event-loop turn — which is the ordering that used to
   * let the close overwrite a valid verdict.
   */
  | { kind: 'reply-then-close'; text: string }
  /**
   * Accept the connection, then never read from it and never answer.
   *
   * The backpressure stall. Once the kernel buffers on both sides fill, the
   * client's `socket.write` returns false and it waits for `drain` — a wait
   * that a peer in this state will never satisfy. Distinct from `silent`,
   * which keeps reading and so never applies backpressure at all.
   */
  | { kind: 'blackhole' };

export interface FakeClamd {
  readonly port: number;
  /** What each command gets. Mutable between calls, so one server serves a suite. */
  behaviours: { version: FakeBehaviour; instream: FakeBehaviour; ping: FakeBehaviour };
  /** Bytes received in the most recent INSTREAM body, unframed. */
  lastStreamBytes(): Buffer;
  /** How many frames the client sent, which is how chunking is observed. */
  lastFrameCount(): number;
  /**
   * Connections opened and closed since the server started.
   *
   * The only way a test can assert that the client actually let a socket go.
   * A scan that returns while its connection is still open has not finished —
   * it has stopped waiting, and clamd is still holding a scanning thread for
   * it until its own ReadTimeout fires.
   */
  connections(): { opened: number; closed: number };
  /** Resolves once every connection this server accepted has closed. */
  waitForAllClosed(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeClamd(
  initial: Partial<FakeClamd['behaviours']> = {},
): Promise<FakeClamd> {
  const behaviours: FakeClamd['behaviours'] = {
    version: { kind: 'reply', text: `ClamAV 1.5.4/28108/Sun Aug 30 06:27:10 2026\0` },
    instream: { kind: 'reply', text: 'stream: OK\0' },
    ping: { kind: 'reply', text: 'PONG\0' },
    ...initial,
  };

  let streamBytes = Buffer.alloc(0);
  let frameCount = 0;
  let opened = 0;
  let closed = 0;

  const server = net.createServer((socket) => {
    opened += 1;
    socket.on('close', () => {
      closed += 1;
    });

    let buffer = Buffer.alloc(0);
    let mode: 'command' | 'stream' | null = null;
    let received = Buffer.alloc(0);
    let frames = 0;

    const answer = (behaviour: FakeBehaviour): void => {
      switch (behaviour.kind) {
        case 'reply':
          socket.write(Buffer.from(behaviour.text, 'latin1'));
          break;
        case 'split':
          socket.write(Buffer.from(behaviour.first, 'latin1'));
          setTimeout(
            () => socket.write(Buffer.from(behaviour.second, 'latin1')),
            behaviour.delayMs,
          ).unref?.();
          break;
        case 'silent':
          break;
        case 'close':
          socket.destroy();
          break;
        case 'reply-then-close':
          // `end` rather than `write` + `destroy`: destroy can discard a write
          // that has not flushed, which would make this a test of a dropped
          // reply rather than of a reply followed by a close.
          socket.end(Buffer.from(behaviour.text, 'latin1'));
          break;
        case 'blackhole':
          // Stop consuming. The socket stays open and the send window closes.
          socket.pause();
          break;
        case 'flood': {
          // Deliberately unterminated. Written in one go so the client's
          // accumulator sees it as a single oversized arrival, and again on a
          // timer so a client that ignored the first is still not left waiting
          // on a peer that has gone quiet.
          const filler = Buffer.alloc(behaviour.bytes, 0x41);
          socket.write(filler);
          const again = setInterval(() => socket.write(filler), 50);
          socket.on('close', () => clearInterval(again));
          break;
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Commands first: NUL-terminated, in the `z` form.
      while (mode === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;

        const command = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);

        if (command === 'zVERSION') {
          answer(behaviours.version);
        } else if (command === 'zPING') {
          answer(behaviours.ping);
        } else if (command === 'zINSTREAM') {
          mode = 'stream';
          if (behaviours.instream.kind === 'blackhole') {
            // Applied on the command rather than after the body, because the
            // whole point is that the body never finishes arriving.
            socket.pause();
            return;
          }
        } else {
          socket.write(Buffer.from('UNKNOWN COMMAND\0', 'latin1'));
        }
      }

      // Then framed chunks until the zero-length terminator.
      while (mode === 'stream' && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          buffer = buffer.subarray(4);
          streamBytes = received;
          frameCount = frames;
          mode = null;
          answer(behaviours.instream);
          return;
        }
        if (buffer.length < 4 + length) return;

        received = Buffer.concat([received, buffer.subarray(4, 4 + length)]);
        frames += 1;
        buffer = buffer.subarray(4 + length);
      }
    });

    // A client that gives up mid-stream is normal here; it must not print.
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    behaviours,
    lastStreamBytes: () => streamBytes,
    lastFrameCount: () => frameCount,
    connections: () => ({ opened, closed }),
    waitForAllClosed: async (timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (closed < opened && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (closed < opened) {
        throw new Error(`${opened - closed} connection(s) were still open after ${timeoutMs}ms`);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sockets held open by a `silent` behaviour would otherwise keep the
        // server alive past the test that started it.
        server.unref();
        resolve();
      }),
  };
}

/**
 * A port nothing is listening on.
 *
 * Bound and released, so the number is real and free rather than guessed —
 * a guessed port occasionally belongs to something else on a CI runner, and
 * the test then proves nothing about a refused connection.
 */
export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
