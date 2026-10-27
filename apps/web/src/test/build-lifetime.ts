import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A parent-held child, never a PID recovered from disk. No async gap before kill. */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(signal);
}

export interface FixtureLifetime {
  group(): Promise<boolean>;
  wrapper(signal: NodeJS.Signals): boolean;
  close(): Promise<void>;
}
const fixtures = new Set<FixtureLifetime>();
export function trackFixture(fixture: FixtureLifetime): void {
  fixtures.add(fixture);
}

/** Both afterEach and watchdog use this boundary; disk records are observation only. */
export async function stopFixture(fixture: FixtureLifetime): Promise<boolean> {
  const sent = await fixture.group();
  fixture.wrapper('SIGKILL');
  return sent;
}
export async function cleanupFixtures(): Promise<void> {
  const failures: unknown[] = [];
  for (const fixture of fixtures) {
    try {
      await stopFixture(fixture);
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.close();
    } catch (error) {
      failures.push(error);
    } finally {
      fixtures.delete(fixture);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed');
}
export async function watchdogFixture(fixture: FixtureLifetime): Promise<never> {
  const sent = await stopFixture(fixture);
  throw new Error(
    sent
      ? 'fixture watchdog expired; requested owned supervisor shutdown'
      : 'fixture watchdog expired; supervisor lifetime unavailable; no group signal authorized',
  );
}

/** One accepted connection, held for its lifetime. No lookup/reconnect after EOF. */
export function supervisorEndpoint(): {
  path: string;
  ready: Promise<void>;
  request(target: 'group' | 'root', signal?: NodeJS.Signals): Promise<boolean>;
  close(): Promise<void>;
  wrapperEnded(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'build-control-'));
  const path = join(dir, 'ipc');
  let socket: Socket | undefined;
  let retired = false;
  let connected = false;
  let settle: () => void;
  const accepted = new Promise<void>((resolve) => (settle = resolve));
  const server = createServer((incoming) => {
    if (retired || connected) return incoming.destroy();
    connected = true;
    socket = incoming;
    incoming.once('close', () => {
      retired = true;
      settle();
    });
    incoming.on('error', () => incoming.destroy());
    server.close();
    settle();
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    path,
    ready,
    async request(target, signal) {
      // Startup is bounded too. Timeout permanently retires this endpoint.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        accepted,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            retired = true;
            resolve();
          }, 5_000);
        }),
      ]);
      clearTimeout(timer);
      if (retired || !socket || socket.destroyed) return false;
      return new Promise<boolean>((resolve) => {
        socket?.write(JSON.stringify({ target, signal }) + '\n', (error) => {
          if (error) retired = true;
          resolve(!error);
        });
      });
    },
    wrapperEnded() {
      // A wrapper that never received a root cannot leave an established controller.
      // Wake pending startup requests without consulting any recorded process number.
      if (!connected) {
        retired = true;
        settle();
      }
    },
    async close() {
      retired = true;
      settle();
      try {
        if (socket && !socket.destroyed) {
          const held = socket;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('fixture supervisor did not end within cleanup deadline'));
            }, 5_000);
            held.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      } finally {
        socket?.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
