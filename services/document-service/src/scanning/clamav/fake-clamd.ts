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
 * It is in `src/` rather than `test/` because the unit project's roots are
 * `src/`, and it is excluded from the build by the `*.spec.ts` sibling that
 * uses it having no production importer — nothing in the composition root can
 * reach it, and `clamav.scanner.ts` does not know it exists.
 */

export type FakeBehaviour =
  /** Answer this exact string (including any terminator) and stay open. */
  | { kind: 'reply'; text: string }
  /** Answer in two packets, to prove the reply is reassembled. */
  | { kind: 'split'; first: string; second: string; delayMs: number }
  /** Accept the connection and never say anything. */
  | { kind: 'silent' }
  /** Accept and close without answering. */
  | { kind: 'close' };

export interface FakeClamd {
  readonly port: number;
  /** What each command gets. Mutable between calls, so one server serves a suite. */
  behaviours: { version: FakeBehaviour; instream: FakeBehaviour; ping: FakeBehaviour };
  /** Bytes received in the most recent INSTREAM body, unframed. */
  lastStreamBytes(): Buffer;
  /** How many frames the client sent, which is how chunking is observed. */
  lastFrameCount(): number;
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

  const server = net.createServer((socket) => {
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
