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

/**
 * COMPLETED: the supervisor announced its own ending (FINAL before its group SIGKILL, or
 * NORMAL_END before exit 0) before EOF, and the group was then observed absent.
 * LOST: anything else — EOF, send failure, malformed reply or the deadline.
 */
export type Completion = 'COMPLETED' | 'LOST';
export const LOST_DIAGNOSTIC =
  'fixture supervisor lifetime LOST; termination unconfirmed; no numeric fallback';

export interface FixtureLifetime {
  group(): Promise<Completion>;
  wrapper(signal: NodeJS.Signals): boolean;
  close(): Promise<void>;
}
const fixtures = new Set<FixtureLifetime>();
export function trackFixture(fixture: FixtureLifetime): void {
  fixtures.add(fixture);
}

/** Both afterEach and watchdog use this boundary; disk records are observation only. */
export async function stopFixture(fixture: FixtureLifetime): Promise<Completion> {
  try {
    return await fixture.group();
  } finally {
    fixture.wrapper('SIGKILL');
  }
}
export async function cleanupFixtures(): Promise<void> {
  const failures: unknown[] = [];
  for (const fixture of fixtures) {
    try {
      if ((await stopFixture(fixture)) === 'LOST') throw new Error(LOST_DIAGNOSTIC);
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
  const outcome = await stopFixture(fixture);
  throw new Error(
    outcome === 'COMPLETED'
      ? 'fixture watchdog expired; owned group shutdown COMPLETED'
      : `fixture watchdog expired; ${LOST_DIAGNOSTIC}`,
  );
}

/** Observation only: a signal-0 probe never authorizes a signal. */
const groupAbsent = (group: number): boolean => {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

/** The controller's command channel, next to its event channel `path`. */
export const commandPath = (path: string): string => `${path}.commands`;

/**
 * One acknowledged lifecycle over two one-way channels, each accepted once and held:
 * events (READY / ACK / FINAL / NORMAL_END, then EOF) and commands. EOF alone never
 * confirms cleanup, and a failed command write can never discard an unread event.
 */
export function supervisorEndpoint(deadlineMs = 5_000): {
  path: string;
  ready: Promise<void>;
  connected: Promise<void>;
  ended: Promise<Completion>;
  request(target: 'group'): Promise<Completion>;
  request(target: 'root', signal: NodeJS.Signals): Promise<boolean>;
  close(): Promise<void>;
  noSupervisor(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'build-control-'));
  const path = join(dir, 'ipc');
  let socket: Socket | undefined;
  let commands: Socket | undefined;
  let connected = false;
  let group: number | undefined;
  let announced = false;
  let outcome: Completion | undefined;
  let sequence = 0;
  let onConnected: () => void;
  const transportConnected = new Promise<void>((resolve) => (onConnected = resolve));
  let onEnded: (outcome: Completion) => void;
  const ended = new Promise<Completion>((resolve) => (onEnded = resolve));
  const acknowledgements = new Map<number, boolean>();
  const listeners = new Set<() => void>();
  const wake = (): void => {
    for (const listener of listeners) listener();
  };
  const settle = (result: Completion): void => {
    if (outcome) return;
    outcome = result;
    onEnded(result);
    wake();
  };
  const lose = (): void => settle('LOST');
  const eof = (): void => {
    if (outcome) return;
    if (!announced || group === undefined) return lose();
    // Announced ending: confirm the group is gone within the deadline (observation only).
    const owned = group;
    const deadline = performance.now() + deadlineMs;
    const check = (): void => {
      if (outcome) return;
      if (groupAbsent(owned)) return settle('COMPLETED');
      if (performance.now() >= deadline) return lose();
      setTimeout(check, 10);
    };
    check();
  };
  const server = createServer((incoming) => {
    if (outcome || connected) return incoming.destroy();
    connected = true;
    socket = incoming;
    onConnected();
    let buffer = '';
    incoming.on('data', (data) => {
      buffer += data;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { kind?: unknown; id?: unknown; acted?: unknown; group?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          message = {};
        }
        if (message.kind === 'READY' && group === undefined && Number.isInteger(message.group))
          group = message.group as number;
        else if (message.kind === 'ACK' && typeof message.id === 'number')
          acknowledgements.set(message.id, message.acted === true);
        else if (message.kind === 'FINAL' || message.kind === 'NORMAL_END') announced = true;
        else {
          lose();
          incoming.destroy();
        }
        wake();
      }
    });
    // Only this channel's EOF decides; an error is followed by that same 'close'.
    incoming.once('close', eof);
    incoming.on('error', () => incoming.destroy());
    server.close();
    wake();
  });
  // Write-only. Its failure settles nothing: the event channel or the deadline decides.
  const commandServer = createServer((incoming) => {
    if (outcome || commands) return incoming.destroy();
    commands = incoming;
    incoming.on('error', () => incoming.destroy());
    commandServer.close();
    wake();
  });
  const listen = (on: ReturnType<typeof createServer>, at: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      on.once('error', reject);
      on.listen(at, resolve);
    });
  const ready = Promise.all([listen(server, path), listen(commandServer, commandPath(path))]).then(
    () => undefined,
  );
  let groupRequest: Promise<Completion> | undefined;
  function command(target: 'group' | 'root', signal?: NodeJS.Signals): Promise<unknown> {
    const id = ++sequence;
    // The SAME timer spans connection, READY, the ACK and confirmed completion.
    return new Promise((resolve) => {
      let sent = false;
      const finish = (result: unknown): void => {
        clearTimeout(timer);
        listeners.delete(update);
        acknowledgements.delete(id);
        resolve(result);
      };
      const update = (): void => {
        if (outcome) return finish(target === 'group' ? outcome : false);
        if (group !== undefined && !sent && commands && !commands.destroyed) {
          sent = true;
          commands.write(JSON.stringify({ id, target, signal }) + '\n', () => {});
        }
        if (target === 'root' && acknowledgements.has(id)) finish(acknowledgements.get(id));
      };
      const timer = setTimeout(() => {
        lose();
        socket?.destroy();
        commands?.destroy();
      }, deadlineMs);
      listeners.add(update);
      update();
    });
  }
  function request(target: 'group'): Promise<Completion>;
  function request(target: 'root', signal: NodeJS.Signals): Promise<boolean>;
  function request(target: 'group' | 'root', signal?: NodeJS.Signals): Promise<unknown> {
    if (target === 'root') return command(target, signal);
    groupRequest ??= command(target) as Promise<Completion>;
    return groupRequest;
  }
  return {
    path,
    ready,
    connected: transportConnected,
    ended,
    request,
    noSupervisor() {
      // An explicit wrapper report: it never spawned a supervisor, so no group exists.
      if (!connected) settle('COMPLETED');
    },
    async close() {
      lose();
      socket?.destroy();
      commands?.destroy();
      for (const listening of [server, commandServer])
        if (listening.listening)
          await new Promise<void>((resolve) => listening.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
